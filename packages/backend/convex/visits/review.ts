import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { employeeAt, localDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { append } from "./events";
import { dayCloseAt } from "./policy";

/** Raw device fixes and late-sync holds are reviewed by the people who decide
 * location exceptions (super_admin, manager), within their organizational scope. */
const REVIEW = "visit.locationException.approve" as const;
const MAX_DAY_CALLS = 200;
const MAX_FIXES_PER_CALL = 10;

const nullableNumber = v.union(v.number(), v.null());
const tracePoint = v.object({
  visitId: v.id("visitExecutions"),
  outletId: v.id("outlets"),
  outletName: v.string(),
  plannedVisitId: v.union(v.id("plannedVisits"), v.null()),
  event: v.union(v.literal("check_in"), v.literal("check_out")),
  deviceTime: v.number(),
  serverTime: v.number(),
  latitude: nullableNumber,
  longitude: nullableNumber,
  accuracyMeters: nullableNumber,
  provider: v.string(),
  mockSignal: v.boolean(),
  distanceMeters: nullableNumber,
  radiusMeters: nullableNumber,
  /** within_radius | outside_radius | unavailable | unreliable — a flag, never a block. */
  result: v.string(),
  reviewStatus: v.string(),
  /** Delivered after the service day's 10 PM Manila close. */
  late: v.boolean(),
});

async function inScope(ctx: QueryCtx, unitId: Doc<"orgUnits">["_id"]) {
  try {
    await requireCapability(ctx, REVIEW, unitId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-day location trace (client answer 13): every check-in and check-out fix a
 * salesperson recorded on a Manila service date, in phone-time order, with accuracy,
 * distance from the verified outlet pin and the flag result. Supervisors use it to
 * trace the day; nothing here gates a check-in.
 */
export const trace = query({
  args: { profileId: v.id("profiles"), serviceDate: v.string() },
  returns: v.object({
    serviceDate: v.string(),
    closeAt: v.number(),
    points: v.array(tracePoint),
  }),
  handler: async (ctx, { profileId, serviceDate }) => {
    localDate(serviceDate);
    const current = await employeeAt(ctx, profileId, Date.now());
    await requireCapability(ctx, REVIEW, current.orgUnitId!);
    const visits = await ctx.db
      .query("visitExecutions")
      .withIndex(
        "by_organizationId_and_assigneeProfileId_and_serviceDate",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("assigneeProfileId", profileId)
            .eq("serviceDate", serviceDate),
      )
      .take(MAX_DAY_CALLS + 1);
    if (visits.length > MAX_DAY_CALLS) throw new ConvexError("invalid_request");
    const closeAt = dayCloseAt(serviceDate);
    const points: (typeof tracePoint.type)[] = [];
    for (const visit of visits) {
      if (!(await inScope(ctx, visit.orgUnitId))) continue;
      const outlet = await ctx.db.get(visit.outletId);
      const fixes = await ctx.db
        .query("visitLocationEvidence")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_FIXES_PER_CALL);
      for (const fix of fixes)
        points.push({
          visitId: visit._id,
          outletId: visit.outletId,
          outletName: outlet?.name ?? "",
          plannedVisitId: visit.plannedVisitId ?? null,
          event: fix.event,
          deviceTime: fix.deviceTime,
          serverTime: fix.serverTime,
          latitude: fix.latitude ?? null,
          longitude: fix.longitude ?? null,
          accuracyMeters: fix.accuracyMeters ?? null,
          provider: fix.provider,
          mockSignal: fix.mockSignal === true,
          distanceMeters: fix.distanceMeters ?? null,
          radiusMeters: fix.radiusMeters ?? null,
          result: fix.result,
          reviewStatus: fix.reviewStatus,
          late: fix.serverTime > closeAt,
        });
    }
    points.sort(
      (a, b) => a.deviceTime - b.deviceTime || a.serverTime - b.serverTime,
    );
    return { serviceDate, closeAt, points };
  },
});

const lateRow = v.object({
  visitId: v.id("visitExecutions"),
  assigneeProfileId: v.id("profiles"),
  outletId: v.id("outlets"),
  serviceDate: v.string(),
  state: v.string(),
  lateSyncAt: nullableNumber,
  closeAt: v.number(),
});

/** Visits whose day's work arrived after the 10 PM close, awaiting a supervisor. */
export const lateQueue = query({
  args: {
    orgUnitId: v.id("orgUnits"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(lateRow),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { orgUnitId, paginationOpts }) => {
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > 50)
      throw new ConvexError("invalid_request");
    await requireCapability(ctx, REVIEW, orgUnitId);
    const page = await ctx.db
      .query("visitExecutions")
      .withIndex("by_orgUnitId_and_lateReviewStatus_and_serviceDate", (q) =>
        q.eq("orgUnitId", orgUnitId).eq("lateReviewStatus", "pending_review"),
      )
      .order("desc")
      .paginate(paginationOpts);
    return {
      page: page.page.map((row) => ({
        visitId: row._id,
        assigneeProfileId: row.assigneeProfileId,
        outletId: row.outletId,
        serviceDate: row.serviceDate,
        state: row.state,
        lateSyncAt: row.lateSyncAt ?? null,
        closeAt: dayCloseAt(row.serviceDate),
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Accept or reject work that arrived after the close. Never self-reviewed. */
export const decideLateSync = mutation({
  args: {
    visitId: v.id("visitExecutions"),
    decision: v.union(v.literal("accept"), v.literal("reject")),
    reason: v.string(),
  },
  returns: v.object({
    lateReviewStatus: v.union(v.literal("accepted"), v.literal("rejected")),
  }),
  handler: async (ctx, { visitId, decision, reason }) => {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(reason))
      throw new ConvexError("invalid_request");
    const visit = await ctx.db.get(visitId);
    if (!visit || visit.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("out_of_scope");
    const { identity, profile } = await requireCapability(
      ctx,
      REVIEW,
      visit.orgUnitId,
    );
    if (
      profile._id === visit.assigneeProfileId ||
      identity.tokenIdentifier ===
        (await ctx.db.get(visit.assigneeProfileId))?.authSubject
    )
      throw new ConvexError("self_approval_denied");
    if (visit.lateReviewStatus !== "pending_review")
      throw new ConvexError("already_reviewed");
    const lateReviewStatus: "accepted" | "rejected" =
      decision === "accept" ? "accepted" : "rejected";
    const now = Date.now();
    await ctx.db.patch(visit._id, { lateReviewStatus });
    await append(ctx, {
      orgUnitId: visit.orgUnitId,
      entityType: "visit",
      entityId: visit._id,
      kind: "visit.late_sync.decided",
      actorSubject: identity.tokenIdentifier,
      actorRole: profile.role,
      actorOrgUnitId: profile.orgUnitId!,
      source: "web",
      occurredAt: now,
      serverAt: now,
      ownerProfileId: visit.assigneeProfileId,
      summary: { after: lateReviewStatus, reasonCode: reason },
    });
    return { lateReviewStatus };
  },
});
