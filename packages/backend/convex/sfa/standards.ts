import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { requireCapability } from "../lib/capabilities";
import { rootOrgUnitId } from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  evaluateProductiveCall,
  NO_SALES_DUE_TO_INVENTORY,
  PRODUCTIVE_ACTIVITY_CODES,
  PRODUCTIVE_ACTIVITY_LABELS,
  PRODUCTIVE_CALL_RULE_LABELS,
  PRODUCTIVE_CALL_RULE_VERSION,
  productiveCallRuleValidator,
  productiveCodesFromVisitRecords,
  summarizeCalls,
  type CallEvaluation,
} from "./productive_call";
import {
  DEFAULT_SELLING_WEEKDAYS,
  isSellingDay,
  perDiemBasis,
  weekdayOf,
} from "./selling_days";

const MAX_POSITIONS = 100;
const MAX_HISTORY = 50;
const MAX_DAY_VISITS = 200;
const MAX_VISIT_ROWS = 100;

type Standard = Doc<"positionStandards">;

export function standardAt(rows: Standard[], instant: number): Standard | null {
  const active = rows.filter(
    (row) =>
      row.effectiveFrom <= instant &&
      (row.effectiveTo === undefined || row.effectiveTo > instant),
  );
  // Latest start wins if hand-entered rows ever overlap; the seed never overlaps.
  return active.sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0] ?? null;
}

export async function standardsFor(ctx: QueryCtx, positionId: Id<"positions">) {
  return ctx.db
    .query("positionStandards")
    .withIndex("by_positionId_and_effectiveFrom", (q) =>
      q.eq("positionId", positionId),
    )
    .order("desc")
    .take(MAX_HISTORY);
}

const ruleDefinition = v.object({
  ruleVersion: v.string(),
  activities: v.array(v.object({ code: v.string(), label: v.string() })),
  noSalesMarker: v.string(),
  rules: v.array(
    v.object({ code: productiveCallRuleValidator, label: v.string() }),
  ),
  defaultSellingWeekdays: v.array(v.number()),
});

function definition() {
  return {
    ruleVersion: PRODUCTIVE_CALL_RULE_VERSION,
    activities: PRODUCTIVE_ACTIVITY_CODES.map((code) => ({
      code,
      label: PRODUCTIVE_ACTIVITY_LABELS[code],
    })),
    noSalesMarker: NO_SALES_DUE_TO_INVENTORY,
    rules: (["any_listed_activity", "truck_seller"] as const).map((code) => ({
      code,
      label: PRODUCTIVE_CALL_RULE_LABELS[code],
    })),
    defaultSellingWeekdays: [...DEFAULT_SELLING_WEEKDAYS],
  };
}

/**
 * The standards in effect for every active position, plus the productive-call rule they are
 * judged by. Readable by everyone who can read coverage plans (targets are not secret).
 */
export const current = query({
  args: { asOf: v.optional(v.number()) },
  returns: v.object({
    definition: ruleDefinition,
    positions: v.array(
      v.object({
        positionId: v.id("positions"),
        code: v.string(),
        label: v.string(),
        category: v.string(),
        standard: v.union(schema.doc("positionStandards"), v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "mcp.read");
    const instant = args.asOf ?? Date.now();
    const positions = await ctx.db
      .query("positions")
      .withIndex("by_organizationId_and_active", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("active", true),
      )
      .take(MAX_POSITIONS);
    const rows = [];
    for (const position of positions.sort((a, b) =>
      a.code.localeCompare(b.code),
    )) {
      rows.push({
        positionId: position._id,
        code: position.code,
        label: position.label,
        category: position.category,
        standard: standardAt(await standardsFor(ctx, position._id), instant),
      });
    }
    return { definition: definition(), positions: rows };
  },
});

const callStatus = v.union(
  v.literal("productive"),
  v.literal("nonproductive"),
  v.literal("open"),
  v.literal("not_visited"),
  v.literal("off_plan"),
);
const targetResult = v.object({
  calls: v.number(),
  productiveCalls: v.number(),
  productivePct: v.union(v.number(), v.null()),
  callsTargetMet: v.union(v.boolean(), v.null()),
  productiveTargetMet: v.union(v.boolean(), v.null()),
});

/** Manila noon of a service date: the instant a day's assignment and standard are read at. */
function manilaNoon(serviceDate: string) {
  return Date.parse(`${serviceDate}T12:00:00+08:00`);
}

/**
 * One salesperson's day judged against their position standard: calls (route-plan stores
 * visited), productive calls under the any-one-activity rule, per route and in total, whether
 * the day is a selling day, and the per-diem basis.
 */
export const dailyScorecard = query({
  args: { assigneeProfileId: v.id("profiles"), serviceDate: v.string() },
  returns: v.object({
    serviceDate: v.string(),
    weekday: v.number(),
    sellingDay: v.boolean(),
    perDiemBasis: v.union(
      v.literal("eligible"),
      v.literal("no_activity"),
      v.literal("needs_review"),
    ),
    ruleVersion: v.string(),
    position: v.union(
      v.object({ code: v.string(), label: v.string() }),
      v.null(),
    ),
    standard: v.union(
      v.object({
        dailyCallsTarget: v.union(v.number(), v.null()),
        productiveCallTargetPct: v.union(v.number(), v.null()),
        productiveCallRule: productiveCallRuleValidator,
        sellingWeekdays: v.array(v.number()),
        sourceRef: v.string(),
        notes: v.union(v.string(), v.null()),
      }),
      v.null(),
    ),
    total: targetResult,
    routes: v.array(
      v
        .object({ routeId: v.union(v.id("routes"), v.null()) })
        .extend(targetResult.fields),
    ),
    visits: v.array(
      v.object({
        visitId: v.id("visitExecutions"),
        outletId: v.id("outlets"),
        routeId: v.union(v.id("routes"), v.null()),
        state: v.string(),
        status: callStatus,
        matchedCodes: v.array(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    let weekday: number;
    try {
      weekday = weekdayOf(args.serviceDate);
    } catch {
      throw new ConvexError("Service date must be a YYYY-MM-DD date");
    }
    const { profile: caller } = await requireCapability(ctx, "visit.read");
    if (caller.role === "sales" && caller._id !== args.assigneeProfileId)
      throw new ConvexError("Sales can only read their own scorecard");
    const assignee = await ctx.db.get(args.assigneeProfileId);
    if (!assignee) throw new ConvexError("Salesperson not found");

    const instant = manilaNoon(args.serviceDate);
    const assignments = await ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", args.assigneeProfileId).lte("effectiveFrom", instant),
      )
      .order("desc")
      .take(MAX_HISTORY);
    const assignment =
      assignments.find(
        (row) => row.effectiveTo === undefined || row.effectiveTo > instant,
      ) ?? null;

    const visits = await ctx.db
      .query("visitExecutions")
      .withIndex(
        "by_organizationId_and_assigneeProfileId_and_serviceDate",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("assigneeProfileId", args.assigneeProfileId)
            .eq("serviceDate", args.serviceDate),
      )
      .take(MAX_DAY_VISITS + 1);
    if (visits.length > MAX_DAY_VISITS)
      throw new ConvexError("Too many visits on this day to score");

    // Scope: the caller must reach every unit the day's work belongs to.
    const units = new Set<Id<"orgUnits">>();
    const unit = assignment?.orgUnitId ?? assignee.orgUnitId;
    if (unit) units.add(unit);
    for (const visit of visits) units.add(visit.orgUnitId);
    if (!units.size && caller._id !== args.assigneeProfileId) {
      const root = await rootOrgUnitId(ctx);
      if (!root)
        throw new ConvexError("Salesperson has no organizational scope");
      units.add(root);
    }
    for (const id of units) await requireCapability(ctx, "visit.read", id);

    const positionId = assignment?.positionId ?? assignee.positionId;
    const position = positionId ? await ctx.db.get(positionId) : null;
    const standard = position
      ? standardAt(await standardsFor(ctx, position._id), instant)
      : null;
    const rule = standard?.productiveCallRule ?? "any_listed_activity";
    const sellingWeekdays = standard?.sellingWeekdays ?? [
      ...DEFAULT_SELLING_WEEKDAYS,
    ];
    const sellingDay = isSellingDay(args.serviceDate, sellingWeekdays);

    const scored: {
      visit: Doc<"visitExecutions">;
      evaluation: CallEvaluation;
    }[] = [];
    for (const visit of visits) {
      const activities = await ctx.db
        .query("visitActivities")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_VISIT_ROWS);
      const collections = await ctx.db
        .query("fieldCollections")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_VISIT_ROWS);
      const recorded = productiveCodesFromVisitRecords({
        activityKinds: activities.map((row) => row.activity.kind),
        collectionCount: collections.filter((row) => row.status !== "rejected")
          .length,
        reasonCode: visit.reasonCode,
      });
      scored.push({
        visit,
        evaluation: evaluateProductiveCall({
          rule,
          inRoutePlan: visit.source === "planned" && !!visit.plannedVisitId,
          state: visit.state,
          codes: recorded.codes,
          noSalesDueToInventory: recorded.noSalesDueToInventory,
        }),
      });
    }

    const dailyCallsTarget = standard?.dailyCallsTarget ?? null;
    const productiveCallTargetPct = standard?.productiveCallTargetPct ?? null;
    const judge = (evaluations: CallEvaluation[]) => {
      const summary = summarizeCalls(evaluations);
      return {
        ...summary,
        callsTargetMet:
          sellingDay && dailyCallsTarget !== null
            ? summary.calls >= dailyCallsTarget
            : null,
        productiveTargetMet:
          sellingDay &&
          productiveCallTargetPct !== null &&
          summary.productivePct !== null
            ? summary.productivePct >= productiveCallTargetPct
            : null,
      };
    };
    const routeIds = [
      ...new Set(scored.map(({ visit }) => visit.routeId ?? null)),
    ];
    const total = judge(scored.map((row) => row.evaluation));
    return {
      serviceDate: args.serviceDate,
      weekday,
      sellingDay,
      perDiemBasis: perDiemBasis({
        serviceDate: args.serviceDate,
        calls: total.calls,
        sellingWeekdays,
      }),
      ruleVersion: PRODUCTIVE_CALL_RULE_VERSION,
      position: position
        ? { code: position.code, label: position.label }
        : null,
      standard: standard
        ? {
            dailyCallsTarget,
            productiveCallTargetPct,
            productiveCallRule: rule,
            sellingWeekdays,
            sourceRef: standard.sourceRef,
            notes: standard.notes ?? null,
          }
        : null,
      total,
      // Targets are per day, per route.
      routes: routeIds.map((routeId) => ({
        routeId,
        ...judge(
          scored
            .filter(({ visit }) => (visit.routeId ?? null) === routeId)
            .map((row) => row.evaluation),
        ),
      })),
      visits: scored.map(({ visit, evaluation }) => ({
        visitId: visit._id,
        outletId: visit.outletId,
        routeId: visit.routeId ?? null,
        state: visit.state,
        status: evaluation.status,
        matchedCodes: evaluation.matchedCodes,
      })),
    };
  },
});
