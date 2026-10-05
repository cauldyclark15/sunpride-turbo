import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { countsAsSale, toMinor } from "../dsr/model";
import {
  evaluateProductiveCall,
  productiveCodesFromVisitRecords,
  type ProductiveCallRule,
} from "../sfa/productive_call";

/**
 * CVX-032 territory / customer / SKU daily rollups: pure counting rules. Nothing here
 * touches the database; `rollups.ts` reads the source rows and applies the results.
 *
 * Model: every source document (an order, a visit execution, a planned visit) has one
 * stored *contribution* — the figures it adds to its Manila service date's territory,
 * customer and SKU rows. A refresh recomputes the contribution, subtracts the old one
 * and adds the new one, so the daily rows stay exact without re-scanning a day.
 *
 * Counting follows the Daily Sales Report and the daily execution dashboard (the 2 Oct
 * 2026 call answers win): a sale is an order that is not draft/rejected/voided, dated the
 * day the salesman wrote it; returns post as negative orders; a call is a route-plan
 * store visited and checked out, productive when any one listed activity was recorded.
 * Money is PHP centavos.
 */

export const ROLLUP_VERSION = "rollups/2026-10-04";

/** Distinct SKUs read from one order; beyond this the contribution is marked incomplete. */
export const MAX_ORDER_LINES = 500;

/** Figures shared by territory and customer rows. All additive. */
export const rollupMetricsFields = {
  /** Approved MCP stops still planned (not cancelled or replaced) for the day. */
  plannedCalls: v.number(),
  /** Planned stops with at least one checked-out / completed visit. */
  plannedCallsDone: v.number(),
  /** Visit executions of the day in any state, including off-plan visits. */
  visits: v.number(),
  completedVisits: v.number(),
  unplannedVisits: v.number(),
  /** Route-plan stores visited and closed (DAR/DSR rule). */
  calls: v.number(),
  productiveCalls: v.number(),
  /** Field collections not rejected. */
  collections: v.number(),
  collectionsMinor: v.number(),
  /** Orders that count as a sale, with a non-negative total. */
  orders: v.number(),
  salesMinor: v.number(),
  /** Negative (return) orders and their absolute value. */
  returnOrders: v.number(),
  returnsMinor: v.number(),
};
const rollupMetrics = v.object(rollupMetricsFields);
export type RollupMetrics = Infer<typeof rollupMetrics>;

/** Per-SKU figures. Quantity is in the order line's own selling unit, as entered. */
export const skuMetricsFields = {
  orders: v.number(),
  quantity: v.number(),
  salesMinor: v.number(),
  returnOrders: v.number(),
  returnQuantity: v.number(),
  returnsMinor: v.number(),
};
export const skuMetrics = v.object(skuMetricsFields);
export type SkuMetrics = Infer<typeof skuMetrics>;

export const skuContribution = v.object({
  productCode: v.string(),
  ...skuMetricsFields,
});
export type SkuContribution = Infer<typeof skuContribution>;

export const contributionFields = {
  serviceDate: v.string(),
  orgUnitId: v.id("orgUnits"),
  territoryId: v.optional(v.id("territories")),
  customerCode: v.optional(v.string()),
  customerId: v.optional(v.id("customers")),
  metrics: rollupMetrics,
  skus: v.array(skuContribution),
  complete: v.boolean(),
};
export const contribution = v.object(contributionFields);
export type Contribution = Infer<typeof contribution>;

export function emptyMetrics(): RollupMetrics {
  return {
    plannedCalls: 0,
    plannedCallsDone: 0,
    visits: 0,
    completedVisits: 0,
    unplannedVisits: 0,
    calls: 0,
    productiveCalls: 0,
    collections: 0,
    collectionsMinor: 0,
    orders: 0,
    salesMinor: 0,
    returnOrders: 0,
    returnsMinor: 0,
  };
}

export function emptySkuMetrics(): SkuMetrics {
  return {
    orders: 0,
    quantity: 0,
    salesMinor: 0,
    returnOrders: 0,
    returnQuantity: 0,
    returnsMinor: 0,
  };
}

/** `a + sign × b`, field by field, over the keys of `a`. */
export function addInto<M extends Record<string, number>>(
  a: M,
  b: M,
  sign: 1 | -1,
): M {
  const out: Record<string, number> = { ...a };
  for (const key of Object.keys(a))
    out[key] = (a[key] ?? 0) + sign * (b[key] ?? 0);
  return out as M;
}

export function isZero(metrics: Record<string, number>) {
  return Object.values(metrics).every((value) => value === 0);
}

export function pickMetrics(row: RollupMetrics): RollupMetrics {
  const out = emptyMetrics();
  for (const key of Object.keys(out) as (keyof RollupMetrics)[])
    out[key] = row[key];
  return out;
}

export function pickSkuMetrics(row: SkuMetrics): SkuMetrics {
  const out = emptySkuMetrics();
  for (const key of Object.keys(out) as (keyof SkuMetrics)[])
    out[key] = row[key];
  return out;
}

/** Two contributions add exactly the same figures to exactly the same rows. */
export function sameContribution(
  a: Contribution | null,
  b: Contribution | null,
) {
  if (a === null || b === null) return a === b;
  return (
    a.serviceDate === b.serviceDate &&
    a.orgUnitId === b.orgUnitId &&
    a.territoryId === b.territoryId &&
    a.customerCode === b.customerCode &&
    a.customerId === b.customerId &&
    a.complete === b.complete &&
    JSON.stringify(pickMetrics(a.metrics)) ===
      JSON.stringify(pickMetrics(b.metrics)) &&
    a.skus.length === b.skus.length &&
    a.skus.every(
      (sku, i) =>
        sku.productCode === b.skus[i]!.productCode &&
        JSON.stringify(pickSkuMetrics(sku)) ===
          JSON.stringify(pickSkuMetrics(b.skus[i]!)),
    )
  );
}

/**
 * What one order adds: null when it is not a sale (draft, rejected, voided) or belongs to
 * another organization. A negative total is a return; its negative lines become SKU
 * returns. Lines are folded per product code and sorted so the result is canonical.
 */
export function orderFigures(
  order: {
    organizationId?: string;
    status: Parameters<typeof countsAsSale>[0];
    total: number;
  },
  lines: readonly {
    productCode: string;
    quantity: number;
    lineTotal: number;
  }[],
  organizationId: string,
): { metrics: RollupMetrics; skus: SkuContribution[] } | null {
  if (
    order.organizationId !== undefined &&
    order.organizationId !== organizationId
  )
    return null;
  if (!countsAsSale(order.status)) return null;
  const metrics = emptyMetrics();
  const isReturn = order.total < 0;
  if (isReturn) {
    metrics.returnOrders = 1;
    metrics.returnsMinor = -toMinor(order.total);
  } else {
    metrics.orders = 1;
    metrics.salesMinor = toMinor(order.total);
  }
  const bySku = new Map<string, SkuContribution>();
  for (const line of lines) {
    const code = line.productCode.trim();
    if (!code) continue;
    const sku = bySku.get(code) ?? { productCode: code, ...emptySkuMetrics() };
    const quantity = Number.isFinite(line.quantity) ? line.quantity : 0;
    const value = toMinor(line.lineTotal);
    if (quantity < 0 || value < 0) {
      sku.returnQuantity += Math.abs(quantity);
      sku.returnsMinor += Math.abs(value);
    } else {
      sku.quantity += quantity;
      sku.salesMinor += value;
    }
    bySku.set(code, sku);
  }
  const skus = [...bySku.values()]
    .map((sku) => ({
      ...sku,
      orders: sku.quantity > 0 || sku.salesMinor > 0 ? 1 : 0,
      returnOrders: sku.returnQuantity > 0 || sku.returnsMinor > 0 ? 1 : 0,
    }))
    .sort((a, b) =>
      a.productCode < b.productCode
        ? -1
        : a.productCode > b.productCode
          ? 1
          : 0,
    );
  return { metrics, skus };
}

const DONE_STATES = new Set(["checked-out", "completed"]);

/** What one visit execution adds, judged exactly as the DAR/ROAR and the DSR judge it. */
export function visitFigures(input: {
  state: string;
  source: "planned" | "unplanned";
  plannedVisitId?: Id<"plannedVisits">;
  reasonCode?: string;
  activityKinds: readonly string[];
  collections: readonly { status: string; amountMinor: number }[];
  rule: ProductiveCallRule;
}): RollupMetrics {
  const metrics = emptyMetrics();
  const counted = input.collections.filter((row) => row.status !== "rejected");
  metrics.visits = 1;
  metrics.completedVisits = DONE_STATES.has(input.state) ? 1 : 0;
  metrics.unplannedVisits = input.source === "unplanned" ? 1 : 0;
  metrics.collections = counted.length;
  metrics.collectionsMinor = counted.reduce(
    (sum, row) => sum + row.amountMinor,
    0,
  );
  const inRoutePlan = input.source === "planned" && !!input.plannedVisitId;
  const recorded = productiveCodesFromVisitRecords({
    activityKinds: input.activityKinds,
    collectionCount: counted.length,
    reasonCode: input.reasonCode,
  });
  const call = evaluateProductiveCall({
    rule: input.rule,
    inRoutePlan,
    state: input.state,
    codes: recorded.codes,
    noSalesDueToInventory: recorded.noSalesDueToInventory,
  });
  metrics.calls = call.isCall ? 1 : 0;
  metrics.productiveCalls = call.status === "productive" ? 1 : 0;
  return metrics;
}

/** What one planned visit adds: null once it was cancelled or replaced. */
export function plannedFigures(input: {
  status: "planned" | "cancelled" | "replaced";
  done: boolean;
}): RollupMetrics | null {
  if (input.status !== "planned") return null;
  const metrics = emptyMetrics();
  metrics.plannedCalls = 1;
  metrics.plannedCallsDone = input.done ? 1 : 0;
  return metrics;
}

/** Whole percent, rounded down; null without a base (same as every SFA report). */
export function ratioPct(part: number, whole: number) {
  return whole > 0 ? Math.floor((part * 100) / whole) : null;
}

/** Headline ratios for a summed set of rows. Higher scopes sum, then divide. */
export function rollupHeadline(metrics: RollupMetrics) {
  return {
    netSalesMinor: metrics.salesMinor - metrics.returnsMinor,
    productivePct: ratioPct(metrics.productiveCalls, metrics.calls),
    planCompletionPct: ratioPct(metrics.plannedCallsDone, metrics.plannedCalls),
  };
}
