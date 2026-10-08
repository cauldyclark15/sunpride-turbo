import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { LOCATION_POLICY, manilaMidnight } from "../location/model";
import { sampleDay } from "./sample_live_map";
import { SAMPLE_PEOPLE } from "./sample_data";

afterEach(() => vi.useRealTimers());

describe("beta live-map sample (SP-0135)", () => {
  const stops = [
    { latitude: 10.31, longitude: 123.89 },
    { latitude: 10.32, longitude: 123.9 },
    { latitude: 10.33, longitude: 123.91 },
  ];

  it("plays a working day at the phone cadence, within 08:00-17:30 Manila", () => {
    const day = "2026-10-08";
    const pings = sampleDay(stops, day, manilaMidnight(day) + 15 * 3_600_000);
    expect(pings[0]!.trigger).toBe("start");
    expect(pings[0]!.recordedAt).toBe(manilaMidnight(day) + 8 * 3_600_000);
    for (let i = 1; i < pings.length; i++) {
      const gap = pings[i]!.recordedAt - pings[i - 1]!.recordedAt;
      expect(gap).toBeGreaterThanOrEqual(LOCATION_POLICY.minSpacingMs);
      expect(gap).toBeLessThanOrEqual(LOCATION_POLICY.stillIntervalMs);
    }
    expect(pings.some((p) => p.trigger === "moving")).toBe(true);
    expect(pings.at(-1)!.recordedAt).toBeLessThanOrEqual(
      manilaMidnight(day) + 15 * 3_600_000,
    );
    expect(sampleDay(stops, day, manilaMidnight(day) + 7 * 3_600_000)).toEqual(
      [],
    );
  });

  it("writes flagged pings for signed-up sample testers and clears them", async () => {
    const now = Date.parse("2026-10-08T05:00:00Z"); // 13:00 Manila
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const t: TestConvex<typeof schema> = convexTest(schema, modules);
    await t.mutation(internal.beta.sample.seed, {});
    const salesTester = SAMPLE_PEOPLE.find((p) => p.key === "sales")!;
    // Nobody signed up yet: nothing to attach pings to.
    const empty = await t.mutation(internal.beta.sample_live_map.seed, { now });
    expect(empty.pings).toBe(0);
    expect(empty.skipped).toHaveLength(2);
    await t.run(async (ctx) => {
      const invitation = (await ctx.db
        .query("accessInvitations")
        .withIndex("by_email", (q) => q.eq("email", salesTester.email))
        .unique())!;
      const unit = (await ctx.db
        .query("orgUnits")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride").eq("code", salesTester.orgUnit),
        )
        .unique())!;
      const profile = await ctx.db.insert("profiles", {
        authSubject: "https://auth.test|rhea",
        name: salesTester.name,
        email: salesTester.email,
        role: "sales",
        status: "active",
        orgUnitId: unit._id,
        updatedAt: now,
      });
      await ctx.db.patch(invitation._id, { profileId: profile });
    });
    const seeded = await t.mutation(internal.beta.sample_live_map.seed, {
      now,
    });
    expect(seeded.pings).toBeGreaterThan(50);
    expect(seeded.tracked).toEqual([`${salesTester.name} (field app)`]);
    const rows = await t.run(async (ctx) => ({
      pings: await ctx.db.query("locationPings").collect(),
      live: await ctx.db.query("liveLocations").collect(),
    }));
    expect(rows.pings.every((p) => p.sample === true)).toBe(true);
    expect(rows.live).toHaveLength(1);
    expect(rows.live[0]!.sample).toBe(true);
    // Re-running replaces, never duplicates.
    const again = await t.mutation(internal.beta.sample_live_map.seed, { now });
    expect(again.pings).toBe(seeded.pings);
    const count = await t.run(
      async (ctx) => (await ctx.db.query("locationPings").collect()).length,
    );
    expect(count).toBe(seeded.pings);
    expect(await t.mutation(internal.beta.sample_live_map.clear, {})).toEqual({
      deleted: seeded.pings + 1,
      isDone: true,
    });
  });
});
