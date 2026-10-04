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
  return { t, sales, deviceId, challenge };
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

  it("budgets invalid retries per identity and blocks its challenges until it backs off", async () => {
    const f = await fixture();
    const subject = f.sales.subject;
    expect(
      await f.t.query(internal.mobile.rate_limits.backoff, {
        subject,
        now: START,
      }),
    ).toBe(0);
    let wait = 0;
    for (let i = 0; i < FAILURE_BUCKET.capacity; i += 1)
      wait = await f.t.mutation(internal.mobile.rate_limits.recordFailure, {
        subject,
      });
    expect(wait).toBe(FAILURE_BUCKET.refillMs);
    expect(
      await f.t.query(internal.mobile.rate_limits.backoff, {
        subject,
        now: START,
      }),
    ).toBe(FAILURE_BUCKET.refillMs);
    // Another identity is unaffected.
    expect(
      await f.t.query(internal.mobile.rate_limits.backoff, {
        subject: "issuer|someone-else",
        now: START,
      }),
    ).toBe(0);
    await expect(f.challenge()).rejects.toThrow("rate_limited");
    // Hammering while blocked does not extend the lockout beyond one refill.
    expect(
      await f.t.mutation(internal.mobile.rate_limits.recordFailure, {
        subject,
      }),
    ).toBe(FAILURE_BUCKET.refillMs);
    vi.setSystemTime(START + FAILURE_BUCKET.refillMs);
    expect(
      await f.t.query(internal.mobile.rate_limits.backoff, {
        subject,
        now: Date.now(),
      }),
    ).toBe(0);
    await f.challenge();
  });
});
