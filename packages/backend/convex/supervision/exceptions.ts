import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  actorNames,
  DECISION_KIND,
  evidenceDecision,
  personDay,
  supervisionArgs,
  supervisorContext,
  teamMembers,
  visitEvidence,
  type SupervisionFilters,
  type SupervisorContext,
} from "./access";
import { dayCloseAt, outOfSequence } from "./model";

/** Queue cap per read; the web asks for a narrower unit/channel when it is hit. */
const MAX_ITEMS = 300;

const kind = v.union(
  v.literal("location"),
  v.literal("out_of_sequence"),
  v.literal("unplanned"),
  v.literal("nonproductive"),
  v.literal("rescheduled"),
  v.literal("cancelled"),
  v.literal("not_visited"),
);
const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());
const historyRow = v.object({
  kind: v.string(),
  at: v.number(),
  actorName: v.string(),
  after: nullableString,
  reasonCode: nullableString,
});
const item = v.object({
  id: v.string(),
  kind,
  open: v.boolean(),
  canDecide: v.boolean(),
  profileId: v.id("profiles"),
  personName: v.string(),
  channel: v.string(),
  outletCode: v.string(),
  outletName: v.string(),
  at: nullableNumber,
  visitId: v.union(v.id("visitExecutions"), v.null()),
  evidenceId: v.union(v.id("visitLocationEvidence"), v.null()),
  event: v.union(v.literal("check_in"), v.literal("check_out"), v.null()),
  result: nullableString,
  distanceMeters: nullableNumber,
  accuracyMeters: nullableNumber,
  radiusMeters: nullableNumber,
  sequence: nullableNumber,
  after: nullableNumber,
  reason: nullableString,
  decision: v.union(
    v.object({
      status: v.string(),
      reasonCode: nullableString,
      actorName: v.string(),
      at: v.number(),
    }),
    v.null(),
  ),
  history: v.array(historyRow),
});
export type ExceptionItem = typeof item.type;
type Item = ExceptionItem;

/**
 * WEB-023 exception queue for a Manila service date: geofence evidence that needs a decision
 * (decided through `visits/location:decideLocationException`), plus the informational
 * exceptions the client asked supervisors to see — out-of-MCP-order calls, unplanned calls,
 * nonproductive reasons, reschedules/cancellations and planned stops not visited.
 */
export const queue = query({
  args: supervisionArgs,
  returns: v.object({
    serviceDate: v.string(),
    dayCloseAt: v.number(),
    truncated: v.boolean(),
    canDecide: v.boolean(),
    items: v.array(item),
  }),
  handler: async (ctx, args) => {
    const sc = await supervisorContext(ctx, args);
    const { items, peopleTruncated } = await exceptionItems(ctx, sc, args);
    return {
      serviceDate: args.serviceDate,
      dayCloseAt: dayCloseAt(args.serviceDate),
      truncated: peopleTruncated || items.length > MAX_ITEMS,
      canDecide: sc.canDecide,
      items: items.slice(0, MAX_ITEMS),
    };
  },
});

/** Every exception for the day in scope, open first then newest (shared by web and phone). */
export async function exceptionItems(
  ctx: QueryCtx,
  sc: SupervisorContext,
  args: SupervisionFilters,
) {
  const { members, truncated: peopleTruncated } = await teamMembers(
    ctx,
    sc,
    args,
  );
  const nameOf = actorNames(ctx);
  const outlets = new Map<Id<"outlets">, Doc<"outlets"> | null>();
  const outletOf = async (id: Id<"outlets">) => {
    if (!outlets.has(id)) outlets.set(id, await ctx.db.get(id));
    return outlets.get(id) ?? null;
  };
  const history = async (entityId: string) => {
    const rows = await ctx.db
      .query("executionEvents")
      .withIndex("by_entityType_and_entityId_and_serverAt", (q) =>
        q.eq("entityType", "visit").eq("entityId", entityId),
      )
      .take(20);
    const out = [];
    for (const row of rows)
      out.push({
        kind: row.kind,
        at: row.serverAt,
        actorName: await nameOf(row.actorSubject),
        after: row.summary.after ?? null,
        reasonCode: row.summary.reasonCode ?? null,
      });
    return out;
  };
  const items: Item[] = [];
  for (const member of members) {
    const { planned, visits } = await personDay(
      ctx,
      sc,
      member.profile._id,
      args.serviceDate,
    );
    const base = {
      profileId: member.profile._id,
      personName: member.profile.name,
      channel: member.channel,
    };
    const empty = {
      visitId: null,
      evidenceId: null,
      event: null,
      result: null,
      distanceMeters: null,
      accuracyMeters: null,
      radiusMeters: null,
      sequence: null,
      after: null,
      reason: null,
      decision: null,
      open: false,
      canDecide: false,
      history: [],
    };
    const plannedById = new Map(planned.map((row) => [row._id, row]));
    const broken = outOfSequence(visits, (visit) =>
      visit.plannedVisitId
        ? plannedById.get(visit.plannedVisitId as Id<"plannedVisits">)
            ?.approvedSnapshot.sequence
        : undefined,
    );
    const ownVisit = member.profile._id === sc.profile._id;
    for (const visit of visits) {
      const outlet = await outletOf(visit.outletId);
      const where = {
        outletCode: outlet?.code ?? "—",
        outletName: outlet?.name ?? "Unknown outlet",
      };
      const visitHistory = await history(visit._id);
      for (const evidence of await visitEvidence(ctx, visit._id)) {
        if (evidence.result === "within_radius") continue;
        const decision = await evidenceDecision(ctx, evidence._id);
        const open = evidence.reviewStatus === "pending_review" && !decision;
        items.push({
          ...base,
          ...where,
          ...empty,
          id: `location:${evidence._id}`,
          kind: "location",
          open,
          canDecide: open && sc.canDecide && !ownVisit,
          at: evidence.serverTime,
          visitId: visit._id,
          evidenceId: evidence._id,
          event: evidence.event,
          result: evidence.result,
          distanceMeters: evidence.distanceMeters ?? null,
          accuracyMeters: evidence.accuracyMeters ?? null,
          radiusMeters: evidence.radiusMeters ?? null,
          decision: decision
            ? {
                status: decision.summary.after ?? "decided",
                reasonCode: decision.summary.reasonCode ?? null,
                actorName: await nameOf(decision.actorSubject),
                at: decision.serverAt,
              }
            : null,
          history: [
            ...visitHistory,
            ...(decision
              ? [
                  {
                    kind: DECISION_KIND,
                    at: decision.serverAt,
                    actorName: await nameOf(decision.actorSubject),
                    after: decision.summary.after ?? null,
                    reasonCode: decision.summary.reasonCode ?? null,
                  },
                ]
              : []),
          ].sort((a, b) => a.at - b.at),
        });
      }
      const jump = broken.get(visit._id);
      if (jump)
        items.push({
          ...base,
          ...where,
          ...empty,
          id: `sequence:${visit._id}`,
          kind: "out_of_sequence",
          at: visit.checkedInAt ?? null,
          visitId: visit._id,
          sequence: jump.sequence,
          after: jump.after,
          history: visitHistory,
        });
      if (visit.source === "unplanned")
        items.push({
          ...base,
          ...where,
          ...empty,
          id: `unplanned:${visit._id}`,
          kind: "unplanned",
          at: visit.checkedInAt ?? null,
          visitId: visit._id,
          reason: visit.unplannedReason ?? null,
          history: visitHistory,
        });
      if (visit.productivity === "nonproductive")
        items.push({
          ...base,
          ...where,
          ...empty,
          id: `nonproductive:${visit._id}`,
          kind: "nonproductive",
          at: visit.checkedOutAt ?? null,
          visitId: visit._id,
          reason: visit.reasonCode ?? null,
          history: visitHistory,
        });
    }
    const visited = new Set(visits.map((visit) => visit.plannedVisitId));
    for (const stop of planned) {
      const where = {
        outletCode: stop.approvedSnapshot.outletCode,
        outletName: stop.approvedSnapshot.outletName,
        sequence: stop.approvedSnapshot.sequence ?? null,
      };
      if (stop.status === "replaced" || stop.status === "cancelled")
        items.push({
          ...base,
          ...empty,
          ...where,
          id: `${stop.status}:${stop._id}`,
          kind: stop.status === "replaced" ? "rescheduled" : "cancelled",
          at: stop.cancelledAt ?? null,
          reason: stop.cancellationReason ?? null,
        });
      else if (!visited.has(stop._id))
        items.push({
          ...base,
          ...empty,
          ...where,
          id: `not_visited:${stop._id}`,
          kind: "not_visited",
          at: null,
        });
    }
  }
  items.sort(
    (a, b) =>
      Number(b.open) - Number(a.open) ||
      (b.at ?? 0) - (a.at ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return { items, peopleTruncated };
}
