import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import type { AuthorizedDevice } from "../mobile/types";
import { assertDevice } from "../mobile/projection";

const NOW = Date.parse("2026-10-05T16:30:00Z");
const encode = (buffer: ArrayBuffer) =>
  btoa(
    Array.from(new Uint8Array(buffer), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
afterEach(() => vi.useRealTimers());
async function fixture(app: "VAN_ANDROID" | "ANDROID" | "IOS") {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t: TestConvex<typeof schema> = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const email = "van-crypto@fixture.test";
  await root.mutation(api.domains.profiles.invite, { email, role: "sales" });
  const seller = t.withIdentity({ subject: "seller", email });
  await seller.mutation(api.domains.profiles.ensure, {});
  const profile = (await seller.query(api.domains.profiles.current, {}))!;
  await t.run(async (ctx) => {
    await ctx.db.patch(profile._id, { orgUnitId: rootUnitId });
    for (const row of await ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", profile._id),
      )
      .collect())
      await ctx.db.delete(row._id);
    await ctx.db.insert("employeeAssignments", {
      profileId: profile._id,
      orgUnitId: rootUnitId,
      role: "sales",
      effectiveFrom: NOW - 1000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: NOW,
    });
  });
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const sign = async (message: string) =>
    encode(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(message),
      ),
    );
  const publicKey = encode(
    await crypto.subtle.exportKey("spki", keys.publicKey),
  );
  const { deviceId } = await root.mutation(api.mobile.devices.register, {
    inventoryTag: `CRYPTO-${app}`,
    allowedApp: app,
    platform: app === "IOS" ? "iOS" : "Android",
    model: "test",
    osVersion: "1",
    appVersion: "1",
    profileId: profile._id,
    publicKey,
  });
  const first = await seller.mutation(api.mobile.devices.challenge, {
    deviceId,
  });
  await seller.mutation(api.mobile.devices.bind, {
    deviceId,
    credentialId: "van-credential",
    attestation: { format: "none" },
    nonce: first.nonce,
    timestamp: NOW,
    proof: await sign(`BIND|${deviceId}|van-credential|${first.nonce}|${NOW}`),
  });
  async function proof(path: string, nonce?: string) {
    const challenge =
      nonce ??
      (await seller.mutation(api.mobile.devices.challenge, { deviceId })).nonce;
    const bodyDigest = "0".repeat(64);
    return {
      deviceId,
      app,
      path,
      method: "POST",
      bodyDigest,
      nonce: challenge,
      timestamp: NOW,
      proof: await sign(`POST|${path}|${bodyDigest}|${challenge}|${NOW}`),
    };
  }
  const actor: AuthorizedDevice = {
    deviceId,
    profileId: profile._id,
    subject: profile.authSubject!,
    orgUnitId: rootUnitId,
    role: "sales",
    scopeFingerprint: "fixture",
  };
  return { t, seller, deviceId, proof, actor };
}

describe("cryptographic app/path separation", () => {
  it("VAN_ANDROID signs only van bootstrap/push; rejection leaves the nonce usable on its proper path", async () => {
    const f = await fixture("VAN_ANDROID");
    for (const path of [
      "/mobile/v1/push",
      "/mobile/v1/bootstrap",
      "/van/v1/pull",
      "/van/v1/push/extra",
    ]) {
      const fields = await f.proof(path);
      await expect(
        f.seller.mutation(internal.mobile.device_auth.authorize, fields),
      ).rejects.toThrow(/Invalid mobile request proof fields/);
      const challenge = await f.t.run((ctx) =>
        ctx.db
          .query("deviceChallenges")
          .withIndex("by_deviceId_and_nonce", (q) =>
            q.eq("deviceId", f.deviceId).eq("nonce", fields.nonce),
          )
          .unique(),
      );
      expect(challenge?.consumedAt).toBeUndefined();
      const authorized = await f.seller.mutation(
        internal.mobile.device_auth.authorize,
        await f.proof("/van/v1/push", fields.nonce),
      );
      expect(authorized).toMatchObject({
        deviceId: f.deviceId,
        profileId: f.actor.profileId,
        role: "sales",
      });
      expect(authorized.scopeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(
      await f.seller.mutation(
        internal.mobile.device_auth.authorize,
        await f.proof("/van/v1/bootstrap"),
      ),
    ).toMatchObject({ deviceId: f.deviceId });
  });

  it.each(["ANDROID", "IOS"] as const)(
    "%s cannot sign a van path even with a valid P-256 proof",
    async (app) => {
      const f = await fixture(app);
      for (const path of ["/van/v1/push", "/van/v1/bootstrap"]) {
        const fields = await f.proof(path);
        await expect(
          f.seller.mutation(internal.mobile.device_auth.authorize, fields),
        ).rejects.toThrow(/Invalid mobile request proof fields/);
        expect(
          await f.seller.mutation(
            internal.mobile.device_auth.authorize,
            await f.proof("/mobile/v1/push", fields.nonce),
          ),
        ).toMatchObject({ deviceId: f.deviceId });
      }
      await expect(
        f.seller.mutation(internal.mobile.device_auth.authorize, {
          ...(await f.proof("/van/v1/push")),
          app: "VAN_ANDROID",
        }),
      ).rejects.toThrow(/not bound for this app/);
    },
  );

  it("van proof burns nonce once, is bound to exact body bytes, and cannot bypass separate field projection/push guards", async () => {
    const f = await fixture("VAN_ANDROID");
    const fields = await f.proof("/van/v1/push");
    await expect(
      f.seller.mutation(internal.mobile.device_auth.authorize, {
        ...fields,
        bodyDigest: "f".repeat(64),
      }),
    ).rejects.toThrow(/Invalid device proof/);
    const authorized = await f.seller.mutation(
      internal.mobile.device_auth.authorize,
      fields,
    );
    await expect(
      f.seller.mutation(internal.mobile.device_auth.authorize, fields),
    ).rejects.toThrow(/expired or used/);
    await expect(
      f.seller.run((ctx) => assertDevice(ctx, authorized, NOW)),
    ).rejects.toThrow(/rebootstrap_required/);
    await expect(
      f.seller.mutation(internal.mobile.push.applyOne, {
        deviceId: f.deviceId,
        actor: authorized,
        operation: {
          kind: "task.complete",
          clientRequestId: "00000000-0000-4000-8000-000000000001",
          payload: {},
        },
      }),
    ).rejects.toThrow(/unauthorized/);
    expect(
      await f.t.run((ctx) =>
        ctx.db.query("processedMobileOperations").collect(),
      ),
    ).toEqual([]);
    expect(
      await f.t.run((ctx) => ctx.db.query("visitExecutions").collect()),
    ).toEqual([]);
  });
});
