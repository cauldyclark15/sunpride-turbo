import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

const encode = (buffer: ArrayBuffer) =>
  btoa(
    Array.from(new Uint8Array(buffer), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );

async function fixture() {
  const t: TestConvex<typeof schema> = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const email = "seller@fixture.test";
  await root.mutation(api.domains.profiles.invite, { email, role: "sales" });
  const actor = t.withIdentity({ subject: "seller", email });
  await actor.mutation(api.domains.profiles.ensure, {});
  const profile = (await actor.query(api.domains.profiles.current, {}))!;
  const now = Date.now() - 100_000;
  await t.run(async (ctx) => {
    await ctx.db.patch(profile._id, {
      role: "sales",
      orgUnitId: rootUnitId,
      updatedAt: now,
    });
    for (const old of await ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", profile._id),
      )
      .collect())
      await ctx.db.delete(old._id);
    await ctx.db.insert("employeeAssignments", {
      profileId: profile._id,
      role: "sales",
      orgUnitId: rootUnitId,
      effectiveFrom: now,
      actorSubject: "issuer|fixture",
      reason: "fixture",
      createdAt: now,
    });
  });
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = encode(
    await crypto.subtle.exportKey("spki", keys.publicKey),
  );
  const { deviceId } = await root.mutation(api.mobile.devices.register, {
    inventoryTag: "TEST-PHONE",
    allowedApp: "ANDROID",
    platform: "Android",
    model: "test",
    osVersion: "1",
    appVersion: "1",
    profileId: profile._id,
    publicKey,
  });
  async function sign(message: string) {
    return encode(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(message),
      ),
    );
  }
  const first = await actor.mutation(api.mobile.devices.challenge, {
    deviceId,
  });
  const timestamp = Date.now(),
    credentialId = "credential";
  await actor.mutation(api.mobile.devices.bind, {
    deviceId,
    credentialId,
    attestation: { format: "none" },
    nonce: first.nonce,
    timestamp,
    proof: await sign(
      `BIND|${deviceId}|${credentialId}|${first.nonce}|${timestamp}`,
    ),
  });
  const digest = "0".repeat(64);
  async function request(
    overrides: Partial<{
      app: "ANDROID" | "IOS";
      method: string;
      path: string;
      bodyDigest: string;
      nonce: string;
      timestamp: number;
      proof: string;
    }> = {},
  ) {
    const nonce =
      overrides.nonce ??
      (await actor.mutation(api.mobile.devices.challenge, { deviceId })).nonce;
    const fields = {
      app: "ANDROID" as const,
      method: "POST",
      path: "/mobile/v1/bootstrap",
      bodyDigest: digest,
      timestamp: Date.now(),
      ...overrides,
      nonce,
    };
    const proof =
      overrides.proof ??
      (await sign(
        `${fields.method}|${fields.path}|${fields.bodyDigest}|${nonce}|${fields.timestamp}`,
      ));
    return { deviceId, ...fields, proof };
  }
  return { t, root, actor, profile, rootUnitId, deviceId, keys, sign, request };
}

describe("server-only device request proof", () => {
  it("checks real P-256 signature and burns nonce atomically", async () => {
    const f = await fixture();
    const args = await f.request();
    const impostor = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const bad = encode(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        impostor.privateKey,
        new TextEncoder().encode(
          `${args.method}|${args.path}|${args.bodyDigest}|${args.nonce}|${args.timestamp}`,
        ),
      ),
    );
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, {
        ...args,
        proof: bad,
      }),
    ).rejects.toThrow();
    const authorized = await f.actor.mutation(
      internal.mobile.device_auth.authorize,
      args,
    );
    expect(authorized).toMatchObject({
      deviceId: f.deviceId,
      profileId: f.profile._id,
      subject: f.profile.authSubject,
      orgUnitId: f.rootUnitId,
      role: "sales",
    });
    expect(authorized.scopeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, args),
    ).rejects.toThrow();
    const changedBody = { ...args, bodyDigest: "f".repeat(64) };
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, changedBody),
    ).rejects.toThrow();
  });

  it("rejects expired/future time, wrong app, unsupported path, another bearer and absent auth", async () => {
    const f = await fixture();
    for (const fields of [
      { timestamp: Date.now() - 120_000 },
      { timestamp: Date.now() + 120_000 },
      { app: "IOS" as const },
      { path: "/api/sap/events" },
    ]) {
      await expect(
        f.actor.mutation(
          internal.mobile.device_auth.authorize,
          await f.request(fields),
        ),
      ).rejects.toThrow();
    }
    const args = await f.request();
    const other = f.t.withIdentity({
      subject: "impostor",
      email: "impostor@test.invalid",
    });
    await expect(
      other.mutation(internal.mobile.device_auth.authorize, args),
    ).rejects.toThrow();
    await expect(
      f.t.mutation(internal.mobile.device_auth.authorize, args),
    ).rejects.toThrow();
    const expired = await f.request();
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("deviceChallenges")
        .withIndex("by_deviceId_and_nonce", (q) =>
          q.eq("deviceId", f.deviceId).eq("nonce", expired.nonce),
        )
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, expired),
    ).rejects.toThrow();
  });

  it("fails closed after suspension, disabled profile, unit transfer and revocation; assignment revision changes fingerprint", async () => {
    const f = await fixture();
    const first = await f.actor.mutation(
      internal.mobile.device_auth.authorize,
      await f.request(),
    );
    const suspended = await f.request();
    await f.t.run((ctx) => ctx.db.patch(f.deviceId, { status: "suspended" }));
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, suspended),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.patch(f.deviceId, { status: "active" }));
    const disabled = await f.request();
    await f.t.run((ctx) => ctx.db.patch(f.profile._id, { status: "disabled" }));
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, disabled),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.patch(f.profile._id, { status: "active" }));
    await f.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", f.profile._id),
        )
        .collect();
      for (const row of rows)
        await ctx.db.patch(row._id, { effectiveTo: Date.now() - 1 });
      await ctx.db.insert("employeeAssignments", {
        profileId: f.profile._id,
        orgUnitId: f.rootUnitId!,
        role: "sales",
        effectiveFrom: Date.now() - 1,
        actorSubject: "issuer|fixture",
        reason: "assignment renewal",
        createdAt: Date.now(),
      });
    });
    const renewed = await f.actor.mutation(
      internal.mobile.device_auth.authorize,
      await f.request(),
    );
    expect(renewed.scopeFingerprint).not.toBe(first.scopeFingerprint);
    const moved = await f.request();
    await f.t.run(async (ctx) => {
      const unitId = await ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "NEW",
        name: "New",
        typeCode: "REGION",
        parentId: f.rootUnitId!,
        status: "active",
        effectiveFrom: Date.now() - 1000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const rows = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", f.profile._id),
        )
        .collect();
      for (const row of rows.filter((row) => row.effectiveTo === undefined))
        await ctx.db.patch(row._id, { effectiveTo: Date.now() - 1 });
      await ctx.db.insert("employeeAssignments", {
        profileId: f.profile._id,
        orgUnitId: unitId,
        role: "sales",
        effectiveFrom: Date.now() - 1,
        actorSubject: "issuer|fixture",
        reason: "transfer",
        createdAt: Date.now(),
      });
      await ctx.db.patch(f.profile._id, { orgUnitId: unitId });
    });
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, moved),
    ).rejects.toThrow();
    // Root administrator still has authority to revoke a transferred device.
    await f.root.mutation(api.mobile.devices.revoke, {
      deviceId: f.deviceId,
      reason: "transfer",
    });
    await expect(
      f.actor.mutation(internal.mobile.device_auth.authorize, moved),
    ).rejects.toThrow();
  });
});
