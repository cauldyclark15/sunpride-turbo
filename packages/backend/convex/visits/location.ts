import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { outletRows, resolveOutletScopeAt } from "../outlets/validation";
import { activeAt } from "../org/validation";
import { append } from "./events";
import { VISIT_LOCATION_POLICY as policy } from "./policy";
import { accessVisit } from "./validation";

export const locationValidator = v.union(
  v.null(),
  v.object({
    latitude: v.number(),
    longitude: v.number(),
    accuracyMeters: v.number(),
    provider: v.union(
      v.literal("gps"),
      v.literal("network"),
      v.literal("fused"),
      v.literal("unknown"),
    ),
    mockSignal: v.optional(v.boolean()),
    fixTime: v.number(),
  }),
);
export type LocationFix = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  provider: "gps" | "network" | "fused" | "unknown";
  mockSignal?: boolean;
  fixTime: number;
} | null;
export function haversine(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad,
    dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export async function recordLocation(
  ctx: MutationCtx,
  visit: Doc<"visitExecutions">,
  event: "check_in" | "check_out",
  location: LocationFix,
  deviceTime: number,
  serverTime: number,
) {
  const pins = (await outletRows(ctx, "outletPins", visit.outletId)).filter(
    (p) =>
      p.status === "verified" &&
      activeAt(p.effectiveFrom, p.effectiveTo, serverTime),
  );
  if (pins.length > 1) throw new ConvexError("invalid_pin_state");
  const pin = pins[0];
  if (
    location &&
    (!Number.isFinite(location.latitude) ||
      Math.abs(location.latitude) > 90 ||
      !Number.isFinite(location.longitude) ||
      Math.abs(location.longitude) > 180 ||
      !Number.isFinite(location.accuracyMeters) ||
      location.accuracyMeters < 0 ||
      !Number.isSafeInteger(location.fixTime) ||
      location.fixTime < 0)
  )
    throw new ConvexError("invalid_request");
  const radius = pin
    ? Math.min(pin.radiusMeters, policy.radiusMeters)
    : undefined;
  if (pin && (!Number.isFinite(radius) || radius! <= 0 || radius! > 500))
    throw new ConvexError("invalid_pin_state");
  const distance = location && pin ? haversine(location, pin) : undefined;
  const unreliable =
    !!location &&
    (location.mockSignal === true ||
      location.provider === "unknown" ||
      location.accuracyMeters > policy.maxAccuracyMeters ||
      location.fixTime > serverTime ||
      serverTime - location.fixTime > policy.maxFixAgeMs);
  const result =
    !location || !pin
      ? "unavailable"
      : unreliable
        ? "unreliable"
        : distance! > radius!
          ? "outside_radius"
          : "within_radius";
  const reviewStatus =
    result === "within_radius" ? "verified" : "pending_review";
  const evidenceId = await ctx.db.insert("visitLocationEvidence", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    orgUnitId: visit.orgUnitId,
    visitId: visit._id,
    event,
    latitude: location?.latitude,
    longitude: location?.longitude,
    accuracyMeters: location?.accuracyMeters,
    provider: location?.provider ?? "unknown",
    mockSignal: location?.mockSignal,
    pinId: pin?._id,
    pinVersion: pin ? `${pin._id}:${pin.effectiveFrom}` : undefined,
    policyVersion: policy.version,
    radiusMeters: radius,
    distanceMeters: distance,
    result,
    reviewStatus,
    deviceTime,
    serverTime,
  });
  return { evidenceId, verification: reviewStatus };
}
export const decideLocationException = mutation({
  args: {
    evidenceId: v.id("visitLocationEvidence"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    reason: v.string(),
  },
  returns: v.object({
    reviewStatus: v.union(
      v.literal("approved_exception"),
      v.literal("rejected"),
    ),
  }),
  handler: async (ctx, { evidenceId, decision, reason }) => {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(reason))
      throw new ConvexError("invalid_request");
    const evidence = await ctx.db.get(evidenceId);
    if (!evidence || evidence.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("out_of_scope");
    const visit = await ctx.db.get(evidence.visitId);
    if (!visit || visit.orgUnitId !== evidence.orgUnitId)
      throw new ConvexError("out_of_scope");
    const { identity, profile } = await requireCapability(
      ctx,
      "visit.locationException.approve",
      visit.orgUnitId,
    );
    await accessVisit(ctx, visit, "visit.read");
    const current = await resolveOutletScopeAt(ctx, visit.outletId, Date.now());
    await requireCapability(
      ctx,
      "visit.locationException.approve",
      current.orgUnitId,
    );
    if (
      profile._id === visit.assigneeProfileId ||
      identity.tokenIdentifier ===
        (await ctx.db.get(visit.assigneeProfileId))?.authSubject
    )
      throw new ConvexError("self_approval_denied");
    if (evidence.reviewStatus !== "pending_review")
      throw new ConvexError("already_reviewed");
    const prior = await ctx.db
      .query("executionEvents")
      .withIndex("by_entityType_and_entityId_and_serverAt", (q) =>
        q.eq("entityType", "visit").eq("entityId", evidenceId),
      )
      .take(2);
    if (prior.length) throw new ConvexError("already_reviewed");
    const reviewStatus: "approved_exception" | "rejected" =
      decision === "approve" ? "approved_exception" : "rejected";
    // Evidence stays immutable; the decision is an independently authored event.
    await append(ctx, {
      orgUnitId: visit.orgUnitId,
      entityType: "visit",
      entityId: evidenceId,
      kind: "location.exception.decided",
      actorSubject: identity.tokenIdentifier,
      actorRole: profile.role,
      actorOrgUnitId: profile.orgUnitId!,
      source: "web",
      occurredAt: Date.now(),
      serverAt: Date.now(),
      ownerProfileId: visit.assigneeProfileId,
      summary: { after: reviewStatus, reasonCode: reason },
      policyVersion: evidence.policyVersion,
    });
    return { reviewStatus };
  },
});
