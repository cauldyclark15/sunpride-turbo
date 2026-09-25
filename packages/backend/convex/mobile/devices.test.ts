import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

const encode = (bytes: ArrayBuffer) =>
  btoa(
    Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(
      "",
    ),
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
  const now = Date.now() - 100_000;
  const [east, west] = await t.run(async (ctx) =>
    Promise.all(
      ["E", "W"].map((code) =>
        ctx.db.insert("orgUnits", {
          organizationId: "sunpride",
          code,
          name: code,
          typeCode: "REGION",
          parentId: rootUnitId!,
          status: "active",
          effectiveFrom: now,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    ),
  );
  const adminEmail = "admin@fixture.test";
  await root.mutation(api.domains.profiles.invite, {
    email: adminEmail,
    role: "admin",
  });
  const admin = t.withIdentity({ subject: "admin", email: adminEmail });
  await admin.mutation(api.domains.profiles.ensure, {});
  async function assign(
    id: Id<"profiles">,
    role: "admin" | "sales",
    unit: Id<"orgUnits">,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { role, orgUnitId: unit, updatedAt: now });
      for (const old of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", id),
        )
        .collect())
        await ctx.db.delete(old._id);
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        role,
        orgUnitId: unit,
        effectiveFrom: now,
        actorSubject: "issuer|fixture",
        reason: "fixture",
        createdAt: now,
      });
    });
  }
  const adminId = (await admin.query(api.domains.profiles.current, {}))!._id;
  await assign(adminId, "admin", east!);
  async function salesPerson(name: string, unit: Id<"orgUnits">) {
    const email = `${name}@fixture.test`;
    await root.mutation(api.domains.profiles.invite, { email, role: "sales" });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const profile = (await actor.query(api.domains.profiles.current, {}))!;
    await assign(profile._id, "sales", unit);
    return { actor, profileId: profile._id, subject: profile.authSubject };
  }
  const sales = await salesPerson("sales", east!);
  const other = await salesPerson("other", east!);
  const foreign = await salesPerson("foreign", west!);
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = encode(
    await crypto.subtle.exportKey("spki", keys.publicKey),
  );
  const registration = {
    inventoryTag: "PHONE-1",
    allowedApp: "ANDROID" as const,
    platform: "Android",
    model: "test",
    osVersion: "1",
    appVersion: "1",
    profileId: sales.profileId,
    publicKey,
  };
  async function register() {
    return admin.mutation(api.mobile.devices.register, registration);
  }
  async function sign(message: string) {
    return encode(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(message),
      ),
    );
  }
  async function bind(deviceId: Id<"registeredDevices">) {
    const { nonce } = await sales.actor.mutation(api.mobile.devices.challenge, {
      deviceId,
    });
    const timestamp = Date.now(),
      credentialId = "device-credential-1";
    return sales.actor.mutation(api.mobile.devices.bind, {
      deviceId,
      credentialId,
      attestation: { format: "none" },
      nonce,
      timestamp,
      proof: await sign(
        `BIND|${deviceId}|${credentialId}|${nonce}|${timestamp}`,
      ),
    });
  }
  return {
    t,
    root,
    rootUnitId,
    east,
    west,
    admin,
    sales,
    other,
    foreign,
    keys,
    registration,
    register,
    sign,
    bind,
  };
}

describe("registered device lifecycle", () => {
  it("looks up only the signed-in employee's exact key and app, including revoked and bound state", async () => {
    const f = await fixture();
    const { deviceId } = await f.register();
    const args = {
      publicKey: f.registration.publicKey,
      app: "ANDROID" as const,
    };
    const mine = () => f.sales.actor.query(api.mobile.devices.mine, args);

    expect(await mine()).toEqual({
      deviceId,
      status: "active",
      bound: false,
      allowedApp: "ANDROID",
    });
    expect(await f.other.actor.query(api.mobile.devices.mine, args)).toBeNull();
    expect(await f.t.query(api.mobile.devices.mine, args)).toBeNull();
    expect(
      await f.sales.actor.query(api.mobile.devices.mine, {
        ...args,
        app: "IOS",
      }),
    ).toBeNull();
    expect(
      await f.sales.actor.query(api.mobile.devices.mine, {
        ...args,
        publicKey: `${args.publicKey} `,
      }),
    ).toBeNull();

    await f.bind(deviceId);
    expect(await mine()).toMatchObject({ deviceId, bound: true });
    await f.admin.mutation(api.mobile.devices.revoke, {
      deviceId,
      reason: "lost",
    });
    expect(await mine()).toEqual({
      deviceId,
      status: "revoked",
      bound: true,
      allowedApp: "ANDROID",
    });
  });
  it("requires an administrator in the employee's stored unit, not a sales or foreign administrator", async () => {
    const f = await fixture();
    await expect(
      f.sales.actor.mutation(api.mobile.devices.register, f.registration),
    ).rejects.toThrow();
    await expect(
      f.admin.mutation(api.mobile.devices.register, {
        ...f.registration,
        profileId: f.foreign.profileId,
      }),
    ).rejects.toThrow();
    const created = await f.register();
    expect(created.status).toBe("active");
    await expect(f.register()).rejects.toThrow();
    await expect(
      f.sales.actor.mutation(api.mobile.devices.revoke, {
        deviceId: created.deviceId,
        reason: "lost",
      }),
    ).rejects.toThrow();
    await expect(
      f.other.actor.mutation(api.mobile.devices.challenge, {
        deviceId: created.deviceId,
      }),
    ).rejects.toThrow();
  });

  it("binds only the enrolled key and same online employee; cannot reuse a challenge", async () => {
    const f = await fixture();
    const { deviceId } = await f.register();
    const { nonce } = await f.sales.actor.mutation(
      api.mobile.devices.challenge,
      { deviceId },
    );
    const timestamp = Date.now(),
      credentialId = "device-credential-1";
    const impostor = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const badProof = encode(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        impostor.privateKey,
        new TextEncoder().encode(
          `BIND|${deviceId}|${credentialId}|${nonce}|${timestamp}`,
        ),
      ),
    );
    const args = {
      deviceId,
      credentialId,
      nonce,
      timestamp,
      attestation: { format: "none" },
      proof: badProof,
    };
    await expect(
      f.sales.actor.mutation(api.mobile.devices.bind, args),
    ).rejects.toThrow();
    await expect(
      f.other.actor.mutation(api.mobile.devices.bind, args),
    ).rejects.toThrow();
    const proof = await f.sign(
      `BIND|${deviceId}|${credentialId}|${nonce}|${timestamp}`,
    );
    expect(
      await f.sales.actor.mutation(api.mobile.devices.bind, { ...args, proof }),
    ).toEqual({ bindingStatus: "bound" });
    await expect(
      f.sales.actor.mutation(api.mobile.devices.bind, { ...args, proof }),
    ).rejects.toThrow();
    const row = await f.t.run((ctx) => ctx.db.get(deviceId));
    expect(row?.boundSubject).toBe(f.sales.subject);
    expect(row?.attestation?.verifiedAt).toBeUndefined();
    const logs = await f.t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(JSON.stringify(logs)).not.toContain(proof);
    expect(JSON.stringify(logs)).not.toContain(f.registration.publicKey);
  });

  it("revokes without deleting queued sync state; replacement requires explicit revocation", async () => {
    const f = await fixture();
    const { deviceId } = await f.register();
    await f.bind(deviceId);
    await f.t.run(async (ctx) =>
      ctx.db.insert("mobileSyncState", {
        organizationId: "sunpride",
        orgUnitId: f.east!,
        deviceId,
        watermark: 1,
        scopeFingerprint: "old",
        leaseIssuedAt: Date.now(),
        leaseExpiresAt: Date.now() + 1000,
        updatedAt: Date.now(),
      }),
    );
    await expect(
      f.admin.mutation(api.mobile.devices.revoke, { deviceId, reason: "" }),
    ).rejects.toThrow();
    await expect(
      f.admin.mutation(api.mobile.devices.revoke, {
        deviceId,
        reason: "secret-token-must-not-be-audited",
      }),
    ).rejects.toThrow();
    const result = await f.admin.mutation(api.mobile.devices.revoke, {
      deviceId,
      reason: "lost",
    });
    expect(result.status).toBe("revoked");
    await expect(
      f.sales.actor.mutation(api.mobile.devices.challenge, { deviceId }),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("mobileSyncState")
          .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceId))
          .unique(),
      ),
    ).toBeTruthy();
    expect(
      (await f.admin.mutation(api.mobile.devices.register, f.registration))
        .status,
    ).toBe("active");
  });

  it("allows stored-unit admin to revoke a disabled or unassigned employee's phone", async () => {
    const f = await fixture();
    const { deviceId } = await f.register();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.sales.profileId, { status: "disabled" });
      const rows = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", f.sales.profileId),
        )
        .collect();
      for (const row of rows)
        await ctx.db.patch(row._id, { effectiveTo: Date.now() - 1 });
    });
    expect(
      (
        await f.admin.mutation(api.mobile.devices.revoke, {
          deviceId,
          reason: "decommissioned",
        })
      ).status,
    ).toBe("revoked");
  });

  it("rejects POS app and inconsistent field platform before registering", async () => {
    const f = await fixture();
    await expect(
      f.admin.mutation(api.mobile.devices.register, {
        ...f.registration,
        allowedApp: "VAN_ANDROID",
      }),
    ).rejects.toThrow();
    await expect(
      f.admin.mutation(api.mobile.devices.register, {
        ...f.registration,
        platform: "iOS",
      }),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) => ctx.db.query("registeredDevices").collect()),
    ).toEqual([]);
  });
});
