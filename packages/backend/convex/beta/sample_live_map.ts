import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { updateLive } from "../location/ingest";
import {
  LOCATION_POLICY,
  manilaDateOf,
  manilaMidnight,
  type PingKind,
} from "../location/model";
import { SAMPLE_PEOPLE, SAMPLE_STORES, SAMPLE_TRUCKS } from "./sample_data";

/**
 * SP-0135 beta sample for the live map: synthetic, clearly marked (`sample: true`) pings for
 * the sample sales tester (field app) and the van tester's truck around their Cebu routes,
 * so the beta map shows movement before real phones send pings. Not real tracking data:
 * every row is flagged, the web map labels it "Sample", and `clear` removes it.
 *
 * Run once per test day after testers have signed up:
 *   bunx convex run beta/sample_live_map:seed '{}'
 * Remove (also needed before `beta/sample:reset`):
 *   bunx convex run beta/sample_live_map:clear '{}'
 */

type Point = { latitude: number; longitude: number };
export type SamplePing = Point & {
  recordedAt: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  batteryPercent: number;
  trigger: "start" | "moving" | "still" | "stop";
};

const HOUR = 3_600_000;
const START_HOUR = 8;
const END_HOUR = 17.5;
/** About 22 km/h through Cebu traffic. */
const SPEED = 6;
const DWELL_MS = 20 * 60_000;

function meters(a: Point, b: Point) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function bearing(a: Point, b: Point) {
  const rad = Math.PI / 180;
  const y =
    Math.sin((b.longitude - a.longitude) * rad) * Math.cos(b.latitude * rad);
  const x =
    Math.cos(a.latitude * rad) * Math.sin(b.latitude * rad) -
    Math.sin(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.cos((b.longitude - a.longitude) * rad);
  return Math.round(((Math.atan2(y, x) / rad + 360) % 360) * 10) / 10;
}

/** Deterministic tiny GPS wobble (~10 m) so a still phone does not sit on one pixel. */
function wobble(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.0002;
}

/**
 * A working day from 08:00 Manila until `until` (at most 17:30): drive between the stops
 * with a ping every 60 s, dwell 20 minutes at each with a ping every 5 minutes, then wait at
 * the last stop. The phone cadence of the real apps (LOCATION_POLICY).
 */
export function sampleDay(
  stops: readonly Point[],
  serviceDate: string,
  until: number,
): SamplePing[] {
  const start = manilaMidnight(serviceDate) + START_HOUR * HOUR;
  const end = Math.min(until, manilaMidnight(serviceDate) + END_HOUR * HOUR);
  const pings: SamplePing[] = [];
  if (!stops.length || end <= start) return pings;
  let t = start;
  let battery = 96;
  const push = (
    point: Point,
    trigger: SamplePing["trigger"],
    speed: number | null,
    heading: number | null,
  ) => {
    battery = Math.max(18, battery - 0.12);
    pings.push({
      latitude: Math.round((point.latitude + wobble(t)) * 1e6) / 1e6,
      longitude: Math.round((point.longitude + wobble(t + 1)) * 1e6) / 1e6,
      recordedAt: t,
      speedMetersPerSecond: speed,
      headingDegrees: heading,
      batteryPercent: Math.round(battery),
      trigger,
    });
  };
  push(stops[0]!, "start", null, null);
  for (let i = 0; i < stops.length && t < end; i++) {
    const here = stops[i]!;
    const dwellEnd = Math.min(end, t + DWELL_MS);
    for (
      t += LOCATION_POLICY.stillIntervalMs;
      t <= dwellEnd;
      t += LOCATION_POLICY.stillIntervalMs
    )
      push(here, "still", 0, null);
    t = dwellEnd;
    const next = stops[i + 1];
    if (!next) break;
    const travel = (meters(here, next) / SPEED) * 1000;
    const steps = Math.max(
      1,
      Math.ceil(travel / LOCATION_POLICY.movingIntervalMs),
    );
    const heading = bearing(here, next);
    for (let s = 1; s <= steps && t < end; s++) {
      t += LOCATION_POLICY.movingIntervalMs;
      if (t > end) break;
      const f = s / steps;
      push(
        {
          latitude: here.latitude + (next.latitude - here.latitude) * f,
          longitude: here.longitude + (next.longitude - here.longitude) * f,
        },
        "moving",
        SPEED,
        heading,
      );
    }
  }
  // Waiting at the last stop until `until`.
  const last = stops[stops.length - 1]!;
  for (
    t += LOCATION_POLICY.stillIntervalMs;
    t <= end;
    t += LOCATION_POLICY.stillIntervalMs
  )
    push(last, "still", 0, null);
  return pings;
}

async function sampleProfile(ctx: MutationCtx, key: string) {
  const person = SAMPLE_PEOPLE.find((row) => row.key === key);
  if (!person) return null;
  const invitation = await ctx.db
    .query("accessInvitations")
    .withIndex("by_email", (q) => q.eq("email", person.email))
    .unique();
  const profile = invitation?.profileId
    ? await ctx.db.get(invitation.profileId)
    : null;
  return profile?.status === "active" && profile.orgUnitId ? profile : null;
}

async function clearSample(ctx: MutationCtx, limit: number) {
  let deleted = 0;
  const pings = await ctx.db
    .query("locationPings")
    .withIndex("by_sample_and_recordedAt", (q) => q.eq("sample", true))
    .take(limit);
  for (const row of pings) {
    await ctx.db.delete(row._id);
    deleted++;
  }
  const live = await ctx.db
    .query("liveLocations")
    .take(LOCATION_POLICY.maxLiveRows * 4);
  for (const row of live)
    if (row.sample) {
      await ctx.db.delete(row._id);
      deleted++;
    }
  return { deleted, isDone: pings.length < limit };
}

async function writeDay(
  ctx: MutationCtx,
  args: {
    kind: PingKind;
    profile: Doc<"profiles">;
    orgUnitId: Id<"orgUnits">;
    vehicleId?: Id<"vehicles">;
    stops: Point[];
    serviceDate: string;
    until: number;
    now: number;
  },
) {
  const pings = sampleDay(args.stops, args.serviceDate, args.until);
  for (const ping of pings) {
    const row = {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      kind: args.kind,
      profileId: args.profile._id,
      clientPingId: `sample-${args.kind}-${args.profile._id}-${ping.recordedAt}`,
      orgUnitId: args.orgUnitId,
      ...(args.vehicleId ? { vehicleId: args.vehicleId } : {}),
      serviceDate: manilaDateOf(ping.recordedAt),
      latitude: ping.latitude,
      longitude: ping.longitude,
      accuracyMeters: ping.trigger === "moving" ? 12 : 18,
      speedMetersPerSecond: ping.speedMetersPerSecond,
      headingDegrees: ping.headingDegrees,
      batteryPercent: ping.batteryPercent,
      mockLocation: false,
      provider: "fused" as const,
      trigger: ping.trigger,
      recordedAt: ping.recordedAt,
      receivedAt: Math.min(args.now, ping.recordedAt + 2_000),
      sample: true,
    };
    await ctx.db.insert("locationPings", row);
    await updateLive(ctx, row);
  }
  return pings.length;
}

/** Writes today's sample trails (replacing earlier sample pings). See the file comment. */
export const seed = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({
    serviceDate: v.string(),
    pings: v.number(),
    tracked: v.array(v.string()),
    skipped: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    await clearSample(ctx, 4_000);
    // Before 08:30 Manila there is nothing of today to show yet: use yesterday.
    let serviceDate = manilaDateOf(now);
    if (now < manilaMidnight(serviceDate) + 8.5 * HOUR)
      serviceDate = manilaDateOf(now - 24 * HOUR);
    const tracked: string[] = [];
    const skipped: string[] = [];
    let total = 0;
    const routeStops = (route: string) =>
      SAMPLE_STORES.filter((store) => store.route === route).map((store) => ({
        latitude: store.lat,
        longitude: store.lng,
      }));
    for (const key of ["sales", "van"] as const) {
      const person = SAMPLE_PEOPLE.find((row) => row.key === key)!;
      const profile = await sampleProfile(ctx, key);
      if (!profile) {
        skipped.push(`${person.email} has not signed up`);
        continue;
      }
      if (key === "sales") {
        total += await writeDay(ctx, {
          kind: "field",
          profile,
          orgUnitId: profile.orgUnitId!,
          stops: routeStops(person.route!),
          serviceDate,
          until: now,
          now,
        });
        tracked.push(`${person.name} (field app)`);
        continue;
      }
      const truck = SAMPLE_TRUCKS[0];
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_organizationId_and_vehicleCode", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("vehicleCode", truck.vehicleCode),
        )
        .first();
      if (!vehicle) {
        skipped.push(
          `${truck.vehicleCode} missing: run beta/sample:seed first`,
        );
        continue;
      }
      total += await writeDay(ctx, {
        kind: "van",
        profile,
        orgUnitId: vehicle.orgUnitId,
        vehicleId: vehicle._id,
        stops: routeStops(person.route!),
        serviceDate,
        until: now,
        now,
      });
      tracked.push(`${truck.vehicleCode} (${person.name})`);
    }
    return { serviceDate, pings: total, tracked, skipped };
  },
});

/** Removes the synthetic pings; repeat until `isDone`. */
export const clear = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), isDone: v.boolean() }),
  handler: async (ctx) => clearSample(ctx, 2_000),
});
