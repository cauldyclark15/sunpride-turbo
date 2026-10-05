import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  available,
  CHALLENGE_BUCKET,
  FAILURE_BUCKET,
  MOBILE_LIMITS,
  take,
} from "./rate_limits";

const START = Date.UTC(2026, 9, 5, 1, 0, 0);
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
  const unit = await t.run((ctx) =>
    ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "E",
      name: "E",
      typeCode: "REGION",
      parentId: rootUnitId!,
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  async function person(name: string, role: "admin" | "sales") {
    const email = `${name}@fixture.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const profile = (await actor.query(api.domains.profiles.current, {}))!;
    await t.run(async (ctx) => {
      await ctx.db.patch(profile._id, {
        role,
        orgUnitId: unit,
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
        role,
        orgUnitId: unit,
        effectiveFrom: now,
        actorSubject: "issuer|fixture",
        reason: "fixture",
        createdAt: now,
      });
    });
    return { actor, profileId: profile._id, subject: profile.authSubject };
  }
  const admin = await person("admin", "admin");
  const sales = await person("sales", "sales");
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const { deviceId } = await admin.actor.mutation(api.mobile.devices.register, {
    inventoryTag: "PHONE-1",
    allowedApp: "ANDROID",
    platform: "Android",
    model: "test",
    osVersion: "1",
    appVersion: "1",
    profileId: sales.profileId,
    publicKey: encode(await crypto.subtle.exportKey("spki", keys.publicKey)),
  });
  const challenge = () =>
    sales.actor.mutation(api.mobile.devices.challenge, { deviceId });
  return { t, sales, deviceId, challenge, privateKey: keys.privateKey };
}

describe("mobile rate limits (QSR-009)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the published batch bounds", () => {
    expect(MOBILE_LIMITS).toEqual({
      maxBodyBytes: 131072,
      maxPushOperations: 20,
      maxPullLimit: 50,
      maxBootstrapLimit: 100,
    });
  });

  it("refills a token bucket fractionally and never above capacity", () => {
    const policy = { capacity: 3, refillMs: 1_000 };
    let state = null;
    for (let i = 0; i < 3; i += 1) {
      const d = take(state, policy, 0);
      expect(d.allowed).toBe(true);
      state = d.state;
    }
    const denied = take(state, policy, 250);
    expect(denied).toMatchObject({ allowed: false, retryAfterMs: 750 });
    expect(take(denied.state, policy, 1_000).allowed).toBe(true);
    expect(available(state, policy, 10_000_000)).toBe(3);
    expect(available({ tokens: 0, updatedAt: 5_000 }, policy, 0)).toBe(0);
  });

  it("allows a reconnect burst, throttles a flood, and recovers with time", async () => {
    const f = await fixture();
    // A day offline: bootstrap pages + pull pages + push batches in one burst.
    for (let i = 0; i < CHALLENGE_BUCKET.capacity; i += 1) await f.challenge();
    await expect(f.challenge()).rejects.toThrow("rate_limited");
    const issued = await f.t.run((ctx) =>
      ctx.db.query("deviceChallenges").collect(),
    );
    expect(issued).toHaveLength(CHALLENGE_BUCKET.capacity);
    vi.setSystemTime(START + CHALLENGE_BUCKET.refillMs);
    await f.challenge();
    await expect(f.challenge()).rejects.toThrow("rate_limited");
    // Intermittent sync (a few requests every 15 minutes) never runs dry.
    for (let cycle = 1; cycle <= 8; cycle += 1) {
      vi.setSystemTime(START + cycle * 15 * 60_000);
      for (let i = 0; i < 10; i += 1) await f.challenge();
    }
  });

  it("reserves invalid-request budget atomically per identity and refunds legitimate requests", async () => {
    const f = await fixture();
    const subject = f.sales.subject;
    const reserve = (who = subject) =>
      f.t.mutation(internal.mobile.rate_limits.reserve, { subject: who });
    // 100 concurrent reservations: exactly `capacity` succeed, no matter the interleaving.
    const waits = await Promise.all(
      Array.from({ length: 100 }, () => reserve()),
    );
    expect(waits.filter((w) => w === 0)).toHaveLength(FAILURE_BUCKET.capacity);
    expect(waits.filter((w) => w === FAILURE_BUCKET.refillMs)).toHaveLength(
      100 - FAILURE_BUCKET.capacity,
    );
    // Another identity is unaffected.
    expect(await reserve("issuer|someone-else")).toBe(0);
    await expect(f.challenge()).rejects.toThrow("rate_limited");
    // Refused reservations spend nothing: one refill restores exactly one attempt.
    vi.setSystemTime(START + FAILURE_BUCKET.refillMs);
    expect(await reserve()).toBe(0);
    expect(await reserve()).toBeGreaterThan(0);
    // A refund returns the unit; refunds never exceed capacity.
    await f.t.mutation(internal.mobile.rate_limits.refund, { subject });
    expect(await reserve()).toBe(0);
    vi.setSystemTime(START + 100 * FAILURE_BUCKET.refillMs);
    for (let i = 0; i < 5; i += 1)
      await f.t.mutation(internal.mobile.rate_limits.refund, { subject });
    const after = await Promise.all(
      Array.from({ length: 20 }, () => reserve()),
    );
    expect(after.filter((w) => w === 0)).toHaveLength(FAILURE_BUCKET.capacity);
    // Legitimate traffic (reserve + refund) never drains the budget.
    vi.setSystemTime(START + 200 * FAILURE_BUCKET.refillMs);
    for (let i = 0; i < 50; i += 1) {
      expect(await reserve()).toBe(0);
      await f.t.mutation(internal.mobile.rate_limits.refund, { subject });
    }
    await f.challenge();
  });

  it("bounds direct bind attempts: 100 concurrent bad proofs, then the identity backs off", async () => {
    const f = await fixture();
    const { nonce } = await f.challenge();
    const credentialId = "credential-1";
    const timestamp = Date.now();
    const impostor = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const sign = async (key: CryptoKey, n: string) =>
      encode(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          new TextEncoder().encode(
            `BIND|${f.deviceId}|${credentialId}|${n}|${timestamp}`,
          ),
        ),
      );
    const bad = await sign(impostor.privateKey, nonce);
    const bind = (n: string, proof: string) =>
      f.sales.actor.mutation(api.mobile.devices.bind, {
        deviceId: f.deviceId,
        credentialId,
        attestation: { format: "none" },
        nonce: n,
        timestamp,
        proof,
      });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, () => bind(nonce, bad)),
    );
    const rejected = outcomes.filter(
      (o) => o.status === "fulfilled" && o.value.bindingStatus === "rejected",
    );
    const throttled = outcomes.filter(
      (o) =>
        o.status === "rejected" && String(o.reason).includes("rate_limited"),
    );
    expect(rejected).toHaveLength(FAILURE_BUCKET.capacity);
    expect(throttled).toHaveLength(100 - FAILURE_BUCKET.capacity);
    // The first rejected attempt burned the challenge; nothing was bound.
    const row = await f.t.run((ctx) => ctx.db.get(f.deviceId));
    expect(row?.boundSubject).toBeUndefined();
    const challenges = await f.t.run((ctx) =>
      ctx.db.query("deviceChallenges").collect(),
    );
    expect(challenges.every((c) => c.consumedAt !== undefined)).toBe(true);
    // Spent budget also blocks new challenges until the identity backs off.
    await expect(f.challenge()).rejects.toThrow("rate_limited");
    vi.setSystemTime(START + FAILURE_BUCKET.refillMs);
    const fresh = await f.challenge();
    expect(
      await bind(fresh.nonce, await sign(f.privateKey, fresh.nonce)),
    ).toEqual({ bindingStatus: "bound" });
  });
});
