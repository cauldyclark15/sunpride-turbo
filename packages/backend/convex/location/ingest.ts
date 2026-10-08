import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { actorValidator } from "../mobile/cursor";
import { devicePerson } from "../mobile/device_auth";
import type { AuthorizedDevice } from "../mobile/types";
import { requireCurrentDeviceActor, requireDeviceTrip } from "../van/access";
import {
  LOCATION_POLICY,
  manilaDateOf,
  pingKindValidator,
  validWirePing,
  wirePing,
  withinWorkHours,
  type PingCode,
  type PingKind,
  type WirePing,
} from "./model";

/** Trip states in which the truck is on the road (van pings outside them are refused). */
const DRIVING: readonly Doc<"vanTrips">["status"][] = [
  "active",
  "closing",
  "reconciling",
  "closed",
  "review_required",
];

export const pingResult = v.object({
  clientPingId: v.string(),
  status: v.union(
    v.literal("accepted"),
    v.literal("duplicate"),
    v.literal("rejected"),
  ),
  code: v.optional(v.string()),
});
type PingResult = typeof pingResult.type;

/**
 * Same per-transaction recheck as `mobile/push.applyOne` (field) and the van gateway
 * (`van/access.requireCurrentDeviceActor`, SP-0104): the proof was verified in an earlier
 * transaction, so suspension, revocation, deactivation or a scope change committed since
 * refuses the whole batch before anything is written.
 */
async function reauthorize(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  kind: PingKind,
) {
  if (kind === "van") {
    await requireCurrentDeviceActor(ctx, actor);
    return;
  }
  let person;
  try {
    person = await devicePerson(ctx, actor.deviceId);
  } catch {
    throw new ConvexError("unauthorized");
  }
  const { device, profile, assignment, subject } = person;
  if (
    profile._id !== actor.profileId ||
    subject !== actor.subject ||
    assignment.orgUnitId !== actor.orgUnitId ||
    profile.role !== actor.role ||
    device.allowedApp === "VAN_ANDROID" ||
    !device.publicKey ||
    !device.credentialId ||
    !device.boundSubject ||
    !actor.scopeFingerprint
  )
    throw new ConvexError("unauthorized");
  try {
    await requireCapability(ctx, "visit.record", actor.orgUnitId);
  } catch {
    throw new ConvexError("unauthorized");
  }
}

const same = (row: Doc<"locationPings">, ping: WirePing) =>
  row.recordedAt === ping.recordedAt &&
  row.latitude === ping.latitude &&
  row.longitude === ping.longitude &&
  row.trigger === ping.trigger;

/**
 * Stores one signed batch of pings (`/mobile/v1/location`, `/van/v1/location`). Each ping
 * gets its own result; `duplicate` = already stored for this device (the phone treats it
 * as done). Idempotent by (device, clientPingId).
 */
export const applyBatch = internalMutation({
  args: {
    actor: actorValidator,
    kind: pingKindValidator,
    pings: v.array(wirePing),
  },
  returns: v.array(pingResult),
  handler: async (ctx, { actor, kind, pings }) => {
    if (pings.length < 1 || pings.length > LOCATION_POLICY.maxBatch)
      throw new ConvexError("invalid_request");
    await reauthorize(ctx, actor, kind);
    const now = Date.now();
    const trips = new Map<string, Doc<"vanTrips"> | null>();
    const results: PingResult[] = [];
    // Accepted in this batch, so spacing also holds within one upload.
    const accepted: number[] = [];
    // A repeated clientPingId inside one request: only its first occurrence is applied.
    const firsts = new Map<string, WirePing>();
    for (const ping of pings)
      if (!firsts.has(ping.clientPingId)) firsts.set(ping.clientPingId, ping);
    const ordered = [...firsts.values()].sort(
      (a, b) => a.recordedAt - b.recordedAt,
    );
    const outcome = new Map<string, PingResult>();
    for (const ping of ordered) {
      const reject = (code: PingCode) =>
        outcome.set(ping.clientPingId, {
          clientPingId: ping.clientPingId,
          status: "rejected",
          code,
        });
      if (!validWirePing(ping, kind)) {
        reject("invalid_request");
        continue;
      }
      const existing = await ctx.db
        .query("locationPings")
        .withIndex("by_deviceId_and_clientPingId", (q) =>
          q
            .eq("deviceId", actor.deviceId)
            .eq("clientPingId", ping.clientPingId),
        )
        .unique();
      if (existing) {
        if (existing.profileId !== actor.profileId || !same(existing, ping))
          reject("conflict");
        else
          outcome.set(ping.clientPingId, {
            clientPingId: ping.clientPingId,
            status: "duplicate",
          });
        continue;
      }
      if (ping.recordedAt - now > LOCATION_POLICY.maxFutureSkewMs) {
        reject("invalid_request");
        continue;
      }
      if (now - ping.recordedAt > LOCATION_POLICY.maxAgeMs) {
        reject("too_old");
        continue;
      }
      let orgUnitId: Id<"orgUnits"> = actor.orgUnitId;
      let trip: Doc<"vanTrips"> | null = null;
      let visitId: Id<"visitExecutions"> | undefined;
      if (kind === "field") {
        if (!withinWorkHours(ping.recordedAt)) {
          reject("outside_work_hours");
          continue;
        }
        if (ping.visitId !== undefined) {
          const id = ctx.db.normalizeId("visitExecutions", ping.visitId);
          const visit = id ? await ctx.db.get(id) : null;
          if (
            !visit ||
            visit.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
            visit.assigneeProfileId !== actor.profileId
          ) {
            reject("out_of_scope");
            continue;
          }
          visitId = visit._id;
        }
      } else {
        const raw = ping.tripId!;
        if (!trips.has(raw)) {
          const id = ctx.db.normalizeId("vanTrips", raw);
          let found: Doc<"vanTrips"> | null = null;
          if (id)
            try {
              found = await requireDeviceTrip(ctx, actor, id);
            } catch {
              found = null;
            }
          trips.set(raw, found);
        }
        trip = trips.get(raw) ?? null;
        if (!trip) {
          reject("out_of_scope");
          continue;
        }
        const skew = LOCATION_POLICY.maxFutureSkewMs;
        if (
          !DRIVING.includes(trip.status) ||
          trip.startedAt === undefined ||
          ping.recordedAt < trip.startedAt - skew ||
          (trip.closedAt !== undefined &&
            ping.recordedAt > trip.closedAt + skew)
        ) {
          reject("trip_not_active");
          continue;
        }
        orgUnitId = trip.orgUnitId;
      }
      const exempt = ping.trigger === "start" || ping.trigger === "stop";
      if (!exempt) {
        const spacing = LOCATION_POLICY.minSpacingMs;
        const near = await ctx.db
          .query("locationPings")
          .withIndex("by_profileId_and_kind_and_recordedAt", (q) =>
            q
              .eq("profileId", actor.profileId)
              .eq("kind", kind)
              .gt("recordedAt", ping.recordedAt - spacing)
              .lt("recordedAt", ping.recordedAt + spacing),
          )
          .first();
        if (
          near ||
          accepted.some((t) => Math.abs(t - ping.recordedAt) < spacing)
        ) {
          reject("too_frequent");
          continue;
        }
      }
      const row = {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        kind,
        profileId: actor.profileId,
        deviceId: actor.deviceId,
        clientPingId: ping.clientPingId,
        orgUnitId,
        ...(trip ? { vehicleId: trip.vehicleId, tripId: trip._id } : {}),
        ...(visitId ? { visitId } : {}),
        serviceDate: manilaDateOf(ping.recordedAt),
        latitude: ping.latitude,
        longitude: ping.longitude,
        accuracyMeters: ping.accuracyMeters,
        speedMetersPerSecond: ping.speedMetersPerSecond,
        headingDegrees: ping.headingDegrees,
        batteryPercent: ping.batteryPercent,
        mockLocation: ping.mockLocation,
        provider: ping.provider,
        trigger: ping.trigger,
        recordedAt: ping.recordedAt,
        receivedAt: now,
      };
      await ctx.db.insert("locationPings", row);
      await updateLive(ctx, row);
      if (!exempt) accepted.push(ping.recordedAt);
      outcome.set(ping.clientPingId, {
        clientPingId: ping.clientPingId,
        status: "accepted",
      });
    }
    // Results go back in request order.
    const used = new Set<string>();
    for (const ping of pings) {
      const result = outcome.get(ping.clientPingId);
      if (used.has(ping.clientPingId) || !result)
        results.push({
          clientPingId: ping.clientPingId,
          status: "rejected",
          code: "invalid_request",
        });
      else results.push(result);
      used.add(ping.clientPingId);
    }
    return results;
  },
});

type PingRow = Omit<Doc<"locationPings">, "_id" | "_creationTime">;

/** Keeps the one latest row per person (field) or truck (van); older pings never win. */
export async function updateLive(ctx: MutationCtx, row: PingRow) {
  const subjectKey =
    row.kind === "van" && row.vehicleId
      ? `van:${row.vehicleId}`
      : `field:${row.profileId}`;
  const live = {
    organizationId: row.organizationId,
    kind: row.kind,
    subjectKey,
    profileId: row.profileId,
    ...(row.deviceId ? { deviceId: row.deviceId } : {}),
    orgUnitId: row.orgUnitId,
    ...(row.vehicleId ? { vehicleId: row.vehicleId } : {}),
    ...(row.tripId ? { tripId: row.tripId } : {}),
    ...(row.visitId ? { visitId: row.visitId } : {}),
    serviceDate: row.serviceDate,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyMeters: row.accuracyMeters,
    speedMetersPerSecond: row.speedMetersPerSecond,
    headingDegrees: row.headingDegrees,
    batteryPercent: row.batteryPercent,
    mockLocation: row.mockLocation,
    provider: row.provider,
    trigger: row.trigger,
    recordedAt: row.recordedAt,
    receivedAt: row.receivedAt,
    trackingEnded: row.trigger === "stop",
    ...(row.sample ? { sample: true } : {}),
  };
  const current = await ctx.db
    .query("liveLocations")
    .withIndex("by_subjectKey", (q) => q.eq("subjectKey", subjectKey))
    .first();
  if (!current) await ctx.db.insert("liveLocations", live);
  else if (current.recordedAt <= row.recordedAt)
    await ctx.db.replace(current._id, live);
}

/**
 * Daily retention (crons.ts): removes pings and stale live positions older than 90 days
 * in bounded batches, rescheduling itself until nothing expired is left.
 */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - LOCATION_POLICY.retentionMs;
    const pings = await ctx.db
      .query("locationPings")
      .withIndex("by_recordedAt", (q) => q.lt("recordedAt", cutoff))
      .take(LOCATION_POLICY.purgeBatch);
    for (const row of pings) await ctx.db.delete(row._id);
    const live = await ctx.db
      .query("liveLocations")
      .withIndex("by_recordedAt", (q) => q.lt("recordedAt", cutoff))
      .take(LOCATION_POLICY.purgeBatch);
    for (const row of live) await ctx.db.delete(row._id);
    const more =
      pings.length === LOCATION_POLICY.purgeBatch ||
      live.length === LOCATION_POLICY.purgeBatch;
    if (more)
      await ctx.scheduler.runAfter(
        0,
        internal.location.ingest.purgeExpired,
        {},
      );
    return { deleted: pings.length + live.length, more };
  },
});
