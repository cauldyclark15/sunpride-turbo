/* Daily agent metric rollups (CVX-031): pure rules shared by the rollup writer and its
 * tests. Nothing here touches the database.
 *
 * One row per field person and Manila service date, counted exactly the way the Daily Sales
 * Report (dsr/report.ts) counts the same day, so a dashboard built on rollups never
 * disagrees with the sheet a supervisor opens:
 *
 * - planned calls: the day's route-plan stores (`plannedVisits` still `planned`);
 * - calls / productive calls: closed visits to route-plan stores, judged by the client's
 *   productive-call rule (sfa/productive_call.ts, call of 2 Oct 2026). An unplanned visit
 *   is not a call;
 * - orders and value: orders that became a sale, dated by when the salesman wrote them
 *   (dsr/model.ts `saleInstant`), net of returns, in PHP centavos;
 * - collections: field collections recorded at the day's visits that were not rejected.
 */
import { v } from "convex/values";
import {
  evaluateProductiveCall,
  productiveCodesFromVisitRecords,
  summarizeCalls,
  type ProductiveCallRule,
} from "../sfa/productive_call";
import { countsAsSale, manilaDateOf, saleInstant, toMinor } from "../dsr/model";

/** Bump when a definition below changes so stale rows can be found and recomputed. */
export const AGENT_METRICS_VERSION = "agent-daily/2026-10-04";

/** The precomputed figures of one person's day. Money is PHP centavos. */
export const agentDayMetricsFields = {
  plannedCalls: v.number(),
  calls: v.number(),
  productiveCalls: v.number(),
  nonproductiveCalls: v.number(),
  /** Whole percent rounded down; null without calls. */
  productivePct: v.union(v.number(), v.null()),
  /** Route-plan stores with no visit at all. */
  plannedNotVisited: v.number(),
  visits: v.number(),
  unplannedVisits: v.number(),
  /** Visits still checked in when the rollup ran. */
  openVisits: v.number(),
  /** Visits closed as skipped, rescheduled or missed. */
  skippedVisits: v.number(),
  /** Day's work that reached the server after the 10 PM close (any review state). */
  lateSyncVisits: v.number(),
  /** Completed visits whose required activity forms were not all recorded (AND-013). */
  visitsMissingActivities: v.number(),
  /** Sum of End − Start on the phone clock for visits that have both. */
  callDurationMs: v.number(),
  timedVisits: v.number(),
  firstStartAt: v.union(v.number(), v.null()),
  lastEndAt: v.union(v.number(), v.null()),
  /** Sale orders (returns excluded) dated to the day. */
  orders: v.number(),
  returnOrders: v.number(),
  /** Distinct customers with a sale order (unique buying accounts). */
  buyingAccounts: v.number(),
  /** Net sales value of the day, returns deducted (centavos), as the DSR's today sales. */
  salesValue: v.number(),
  collections: v.number(),
  collectionsPendingReview: v.number(),
  collectionsValue: v.number(),
  /** The position standard in effect on the day. */
  dailyCallsTarget: v.union(v.number(), v.null()),
  productiveCallTargetPct: v.union(v.number(), v.null()),
};
export const agentDayMetricsValidator = v.object(agentDayMetricsFields);
export type AgentDayMetrics = typeof agentDayMetricsValidator.type;

export type VisitInput = {
  state: string;
  source: "planned" | "unplanned";
  plannedVisitId?: string;
  reasonCode?: string;
  activityKinds: readonly string[];
  collections: readonly {
    status: "recorded" | "pending_review" | "rejected";
    amountMinor: bigint | number;
  }[];
  lateSyncAt?: number;
  missingActivities?: readonly string[];
  startedAt?: number;
  endedAt?: number;
  callDurationMs?: number;
};

export type OrderInput = {
  organizationId?: string;
  customerCode: string;
  status: Parameters<typeof countsAsSale>[0];
  total: number;
  createdAt: number;
  offlineCreatedAt?: number;
};

const OPEN_STATES = new Set(["arrived", "checked-in", "in-progress"]);
const SKIPPED_STATES = new Set(["skipped", "rescheduled", "missed"]);

/** True when the order is a sale the salesman wrote on the Manila service date. */
export function orderBelongsToDay(
  order: OrderInput,
  serviceDate: string,
  organizationId: string,
) {
  return (
    (order.organizationId === undefined ||
      order.organizationId === organizationId) &&
    countsAsSale(order.status) &&
    manilaDateOf(saleInstant(order)) === serviceDate
  );
}

export function summarizeAgentDay(input: {
  serviceDate: string;
  organizationId: string;
  rule: ProductiveCallRule;
  plannedVisitIds: readonly string[];
  visits: readonly VisitInput[];
  orders: readonly OrderInput[];
  dailyCallsTarget: number | null;
  productiveCallTargetPct: number | null;
}): AgentDayMetrics {
  const evaluations = [];
  const visited = new Set<string>();
  let unplannedVisits = 0,
    openVisits = 0,
    skippedVisits = 0,
    lateSyncVisits = 0,
    visitsMissingActivities = 0,
    callDurationMs = 0,
    timedVisits = 0,
    collections = 0,
    collectionsPendingReview = 0,
    collectionsValue = 0;
  let firstStartAt: number | null = null,
    lastEndAt: number | null = null;
  for (const visit of input.visits) {
    const live = visit.collections.filter((row) => row.status !== "rejected");
    const recorded = productiveCodesFromVisitRecords({
      activityKinds: visit.activityKinds,
      collectionCount: live.length,
      reasonCode: visit.reasonCode,
    });
    const inRoutePlan = visit.source === "planned" && !!visit.plannedVisitId;
    evaluations.push(
      evaluateProductiveCall({
        rule: input.rule,
        inRoutePlan,
        state: visit.state,
        codes: recorded.codes,
        noSalesDueToInventory: recorded.noSalesDueToInventory,
      }),
    );
    if (visit.plannedVisitId) visited.add(visit.plannedVisitId);
    if (!inRoutePlan) unplannedVisits++;
    if (OPEN_STATES.has(visit.state)) openVisits++;
    if (SKIPPED_STATES.has(visit.state)) skippedVisits++;
    if (visit.lateSyncAt !== undefined) lateSyncVisits++;
    if (visit.missingActivities?.length) visitsMissingActivities++;
    if (visit.callDurationMs !== undefined) {
      callDurationMs += visit.callDurationMs;
      timedVisits++;
    }
    if (visit.startedAt !== undefined)
      firstStartAt =
        firstStartAt === null
          ? visit.startedAt
          : Math.min(firstStartAt, visit.startedAt);
    if (visit.endedAt !== undefined)
      lastEndAt =
        lastEndAt === null ? visit.endedAt : Math.max(lastEndAt, visit.endedAt);
    for (const row of live) {
      collections++;
      if (row.status === "pending_review") collectionsPendingReview++;
      collectionsValue += Number(row.amountMinor);
    }
  }
  const calls = summarizeCalls(evaluations);

  let orders = 0,
    returnOrders = 0,
    salesValue = 0;
  const buyers = new Set<string>();
  for (const order of input.orders) {
    if (!orderBelongsToDay(order, input.serviceDate, input.organizationId))
      continue;
    salesValue += toMinor(order.total);
    if (order.total < 0) returnOrders++;
    else {
      orders++;
      buyers.add(order.customerCode);
    }
  }

  return {
    plannedCalls: input.plannedVisitIds.length,
    calls: calls.calls,
    productiveCalls: calls.productiveCalls,
    nonproductiveCalls: calls.calls - calls.productiveCalls,
    productivePct: calls.productivePct,
    plannedNotVisited: input.plannedVisitIds.filter((id) => !visited.has(id))
      .length,
    visits: input.visits.length,
    unplannedVisits,
    openVisits,
    skippedVisits,
    lateSyncVisits,
    visitsMissingActivities,
    callDurationMs,
    timedVisits,
    firstStartAt,
    lastEndAt,
    orders,
    returnOrders,
    buyingAccounts: buyers.size,
    salesValue,
    collections,
    collectionsPendingReview,
    collectionsValue,
    dailyCallsTarget: input.dailyCallsTarget,
    productiveCallTargetPct: input.productiveCallTargetPct,
  };
}

/** Field-by-field equality, so an unchanged recompute writes nothing. */
export function sameMetrics(a: AgentDayMetrics, b: AgentDayMetrics) {
  return (
    Object.keys(agentDayMetricsFields) as (keyof AgentDayMetrics)[]
  ).every((key) => a[key] === b[key]);
}
