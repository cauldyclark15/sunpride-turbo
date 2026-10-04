/* Territory / customer / SKU daily rollups (CVX-032). Bounded daily aggregates so the
 * territory, customer and SKU dashboards (ANA-004/005/006) read a few rows per day instead
 * of re-scanning raw orders and visit history.
 *
 * How it stays exact: each source document — an order, a visit execution, a planned visit —
 * keeps one `rollupContributions` row saying what it currently adds to which daily rows.
 * A refresh recomputes that contribution from the source, subtracts the old one and adds
 * the new one. Refreshing twice, or replaying a backfill, changes nothing.
 *
 * Freshness: order writes (domains/orders.ts, inventory/pos.ts) and visit events
 * (visits/events.ts `append`) call `queue*Rollup`, which records one pending refresh per
 * source and schedules `refresh` after REFRESH_DELAY_MS, so a burst of phone operations
 * costs one recompute. Plan activation queues `refreshPlan` for the plan's planned visits.
 * `backfill` walks a whole source table (after deploy or a ROLLUP_VERSION change).
 *
 * Counting rules are pure: ./rollups_model.ts. Docs: docs/architecture/ANALYTICS_ROLLUPS.md.
 */
import { ConvexError, v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import schema from "../schema";
import { localDate } from "../coverage/validation";
import { manilaDateOf, saleInstant } from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds, rootOrgUnitId } from "../lib/scope";
import { activeAt } from "../org/validation";
import { standardAt, standardsFor } from "../sfa/standards";
import {
  addInto,
  emptyMetrics,
  emptySkuMetrics,
  isZero,
  MAX_ORDER_LINES,
  orderFigures,
  pickMetrics,
  pickSkuMetrics,
  plannedFigures,
  ROLLUP_VERSION,
  sameContribution,
  visitFigures,
  type Contribution,
  type RollupMetrics,
  type SkuContribution,
} from "./rollups_model";

/** Debounce: a burst of writes to one source becomes one recompute. */
export const REFRESH_DELAY_MS = 10_000;
/** A pending marker older than this is assumed lost (its refresh failed) and re-armed. */
const STALE_REFRESH_MS = 10 * 60_000;
const MAX_VISIT_ROWS = 100;
const MAX_HISTORY = 50;
const MAX_KEY_ROWS = 50;
const PAGE = 25;
/** Longest date range one history read covers (two months). */
export const MAX_RANGE_DAYS = 62;
/** Rows one history read returns; beyond this it reports `truncated`. */
export const MAX_RANGE_ROWS = 500;
const CROSS_SCOPE_ROLES = new Set(["super_admin", "analyst"]);

type Ctx = QueryCtx | MutationCtx;
type SourceKind = "order" | "visit" | "planned";
const sourceKind = v.union(
  v.literal("order"),
  v.literal("visit"),
  v.literal("planned"),
);

function noonOf(serviceDate: string) {
  return localDate(serviceDate) + 12 * 3_600_000;
}

/* ---------- effective-dated lookups (never throw: a refresh must not wedge) ---------- */

async function territoryOwnerAt(
  ctx: Ctx,
  territoryId: Id<"territories">,
  at: number,
) {
  const rows = await ctx.db
    .query("territoryOwnerships")
    .withIndex("by_territoryId_and_effectiveFrom", (q) =>
      q.eq("territoryId", territoryId).lte("effectiveFrom", at),
    )
    .order("desc")
    .take(MAX_HISTORY);
  return (
    rows.find((row) => activeAt(row.effectiveFrom, row.effectiveTo, at))
      ?.orgUnitId ?? null
  );
}

async function outletTerritoryAt(
  ctx: Ctx,
  outletId: Id<"outlets">,
  at: number,
) {
  const rows = await ctx.db
    .query("outletAssignments")
    .withIndex("by_outletId_and_effectiveFrom", (q) =>
      q.eq("outletId", outletId).lte("effectiveFrom", at),
    )
    .order("desc")
    .take(MAX_HISTORY);
  return (
    rows.find((row) => activeAt(row.effectiveFrom, row.effectiveTo, at))
      ?.territoryId ?? null
  );
}

async function outletCustomerAt(ctx: Ctx, outletId: Id<"outlets">, at: number) {
  const rows = await ctx.db
    .query("outletCustomerLinks")
    .withIndex("by_outletId_and_effectiveFrom", (q) =>
      q.eq("outletId", outletId).lte("effectiveFrom", at),
    )
    .order("desc")
    .take(MAX_HISTORY);
  return (
    rows.find((row) => activeAt(row.effectiveFrom, row.effectiveTo, at))
      ?.customerId ?? null
  );
}

/** The outlet a customer account is linked to on the day (latest link wins). */
async function customerOutletAt(
  ctx: Ctx,
  customerId: Id<"customers">,
  at: number,
) {
  const rows = await ctx.db
    .query("outletCustomerLinks")
    .withIndex("by_customerId_and_effectiveFrom", (q) =>
      q.eq("customerId", customerId).lte("effectiveFrom", at),
    )
    .order("desc")
    .take(MAX_HISTORY);
  return (
    rows.find((row) => activeAt(row.effectiveFrom, row.effectiveTo, at))
      ?.outletId ?? null
  );
}

async function productiveRuleFor(
  ctx: Ctx,
  profileId: Id<"profiles">,
  at: number,
) {
  const rows = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId).lte("effectiveFrom", at),
    )
    .order("desc")
    .take(MAX_HISTORY);
  const assignment = rows.find((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, at),
  );
  const positionId =
    assignment?.positionId ?? (await ctx.db.get(profileId))?.positionId;
  const standard = positionId
    ? standardAt(await standardsFor(ctx, positionId), at)
    : null;
  return standard?.productiveCallRule ?? "any_listed_activity";
}

/** Territory, its owning unit and the customer for an outlet on a day. */
async function placeOfOutlet(
  ctx: Ctx,
  outletId: Id<"outlets">,
  at: number,
  known: {
    territoryId?: Id<"territories">;
    customerId?: Id<"customers">;
    fallbackUnit: Id<"orgUnits"> | null;
  },
) {
  const territoryId =
    known.territoryId ?? (await outletTerritoryAt(ctx, outletId, at));
  const owner = territoryId
    ? await territoryOwnerAt(ctx, territoryId, at)
    : null;
  const customerId =
    known.customerId ?? (await outletCustomerAt(ctx, outletId, at));
  const customer = customerId ? await ctx.db.get(customerId) : null;
  return {
    territoryId: territoryId ?? undefined,
    orgUnitId: owner ?? known.fallbackUnit,
    customerId: customer?._id,
    customerCode: customer?.code,
  };
}

/* ---------------------------- contributions per source ---------------------------- */

async function orderContribution(
  ctx: Ctx,
  orderId: Id<"orders">,
): Promise<Contribution | null> {
  const order = await ctx.db.get(orderId);
  if (!order) return null;
  const lines = await ctx.db
    .query("orderLines")
    .withIndex("by_order", (q) => q.eq("orderId", orderId))
    .take(MAX_ORDER_LINES + 1);
  const figures = orderFigures(
    order,
    lines.slice(0, MAX_ORDER_LINES),
    SUNPRIDE_ORGANIZATION_ID,
  );
  if (!figures) return null;
  const serviceDate = manilaDateOf(saleInstant(order));
  const at = noonOf(serviceDate);
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_code", (q) => q.eq("code", order.customerCode))
    .first();
  const outletId = customer
    ? await customerOutletAt(ctx, customer._id, at)
    : null;
  const outlet = outletId ? await ctx.db.get(outletId) : null;
  const seller = await ctx.db
    .query("profiles")
    .withIndex("by_subject", (q) =>
      q.eq("authSubject", order.salespersonSubject),
    )
    .first();
  const fallbackUnit =
    outlet?.custodianOrgUnitId ??
    seller?.orgUnitId ??
    (await rootOrgUnitId(ctx));
  const place = outlet
    ? await placeOfOutlet(ctx, outlet._id, at, {
        customerId: customer?._id,
        fallbackUnit,
      })
    : { territoryId: undefined, orgUnitId: fallbackUnit };
  if (!place.orgUnitId) return null;
  return {
    serviceDate,
    orgUnitId: place.orgUnitId,
    territoryId: place.territoryId,
    customerCode: order.customerCode,
    customerId: customer?._id,
    metrics: figures.metrics,
    skus: figures.skus,
    complete: lines.length <= MAX_ORDER_LINES,
  };
}

async function visitContribution(
  ctx: Ctx,
  visitId: Id<"visitExecutions">,
): Promise<Contribution | null> {
  const visit = await ctx.db.get(visitId);
  if (!visit || visit.organizationId !== SUNPRIDE_ORGANIZATION_ID) return null;
  const at = noonOf(visit.serviceDate);
  const activities = await ctx.db
    .query("visitActivities")
    .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visitId))
    .take(MAX_VISIT_ROWS + 1);
  const collections = await ctx.db
    .query("fieldCollections")
    .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visitId))
    .take(MAX_VISIT_ROWS + 1);
  const metrics = visitFigures({
    state: visit.state,
    source: visit.source,
    plannedVisitId: visit.plannedVisitId,
    reasonCode: visit.reasonCode,
    activityKinds: activities
      .slice(0, MAX_VISIT_ROWS)
      .map((row) => row.activity.kind),
    collections: collections.slice(0, MAX_VISIT_ROWS).map((row) => ({
      status: row.status,
      amountMinor: Number(row.amountMinor),
    })),
    rule: await productiveRuleFor(ctx, visit.assigneeProfileId, at),
  });
  const place = await placeOfOutlet(ctx, visit.outletId, at, {
    customerId: visit.customerId,
    fallbackUnit: visit.orgUnitId,
  });
  return {
    serviceDate: visit.serviceDate,
    orgUnitId: place.orgUnitId ?? visit.orgUnitId,
    territoryId: place.territoryId,
    customerCode: place.customerCode,
    customerId: place.customerId,
    metrics,
    skus: [],
    complete:
      activities.length <= MAX_VISIT_ROWS &&
      collections.length <= MAX_VISIT_ROWS,
  };
}

async function plannedContribution(
  ctx: Ctx,
  plannedId: Id<"plannedVisits">,
): Promise<Contribution | null> {
  const planned = await ctx.db.get(plannedId);
  if (!planned) return null;
  const executions = await ctx.db
    .query("visitExecutions")
    .withIndex("by_plannedVisitId", (q) => q.eq("plannedVisitId", plannedId))
    .take(MAX_VISIT_ROWS);
  const metrics = plannedFigures({
    status: planned.status,
    done: executions.some(
      (row) => row.state === "checked-out" || row.state === "completed",
    ),
  });
  if (!metrics) return null;
  const snapshot = planned.approvedSnapshot;
  // The signed snapshot is authoritative for where the stop was planned.
  const place = await placeOfOutlet(
    ctx,
    planned.outletId,
    noonOf(planned.serviceDate),
    {
      territoryId: snapshot.territoryId,
      customerId: snapshot.customerId,
      fallbackUnit: snapshot.orgUnitId,
    },
  );
  return {
    serviceDate: planned.serviceDate,
    orgUnitId: place.orgUnitId ?? snapshot.orgUnitId,
    territoryId: place.territoryId,
    customerCode: place.customerCode,
    customerId: place.customerId,
    metrics,
    skus: [],
    complete: true,
  };
}

async function computeContribution(
  ctx: Ctx,
  kind: SourceKind,
  sourceId: string,
): Promise<Contribution | null> {
  if (kind === "order") {
    const id = ctx.db.normalizeId("orders", sourceId);
    return id ? await orderContribution(ctx, id) : null;
  }
  if (kind === "visit") {
    const id = ctx.db.normalizeId("visitExecutions", sourceId);
    return id ? await visitContribution(ctx, id) : null;
  }
  const id = ctx.db.normalizeId("plannedVisits", sourceId);
  return id ? await plannedContribution(ctx, id) : null;
}

/* ------------------------------- applying to rows ------------------------------- */

/** Adds (sign 1) or removes (sign -1) a customer contribution; returns the change in
 * whether the customer bought that day (+1 / 0 / -1) for its territory row. */
async function applyCustomer(
  ctx: MutationCtx,
  c: Contribution & { customerCode: string },
  sign: 1 | -1,
  now: number,
) {
  const rows = await ctx.db
    .query("dailyCustomerMetrics")
    .withIndex("by_customerCode_and_serviceDate", (q) =>
      q.eq("customerCode", c.customerCode).eq("serviceDate", c.serviceDate),
    )
    .take(MAX_KEY_ROWS);
  const row = rows.find(
    (r) => r.orgUnitId === c.orgUnitId && r.territoryId === c.territoryId,
  );
  const before = row ? pickMetrics(row) : emptyMetrics();
  const after = addInto(before, c.metrics, sign);
  if (isZero(after)) {
    if (row) await ctx.db.delete(row._id);
  } else if (row) {
    await ctx.db.patch(row._id, {
      ...after,
      ...(c.customerId ? { customerId: c.customerId } : {}),
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("dailyCustomerMetrics", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      serviceDate: c.serviceDate,
      orgUnitId: c.orgUnitId,
      customerCode: c.customerCode,
      customerId: c.customerId,
      territoryId: c.territoryId,
      ...after,
      updatedAt: now,
    });
  }
  return Number(after.orders > 0) - Number(before.orders > 0);
}

async function applyTerritory(
  ctx: MutationCtx,
  c: Contribution & { territoryId: Id<"territories"> },
  sign: 1 | -1,
  buyingDelta: number,
  now: number,
) {
  const rows = await ctx.db
    .query("dailyTerritoryMetrics")
    .withIndex("by_territoryId_and_serviceDate", (q) =>
      q.eq("territoryId", c.territoryId).eq("serviceDate", c.serviceDate),
    )
    .take(MAX_KEY_ROWS);
  const row = rows.find((r) => r.orgUnitId === c.orgUnitId);
  const metrics = addInto(
    row ? pickMetrics(row) : emptyMetrics(),
    c.metrics,
    sign,
  );
  const buyingCustomers = (row?.buyingCustomers ?? 0) + buyingDelta;
  if (isZero(metrics) && buyingCustomers === 0) {
    if (row) await ctx.db.delete(row._id);
  } else if (row) {
    await ctx.db.patch(row._id, {
      ...metrics,
      buyingCustomers,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("dailyTerritoryMetrics", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      serviceDate: c.serviceDate,
      orgUnitId: c.orgUnitId,
      territoryId: c.territoryId,
      ...metrics,
      buyingCustomers,
      updatedAt: now,
    });
  }
}

async function applySku(
  ctx: MutationCtx,
  c: Contribution,
  sku: SkuContribution,
  sign: 1 | -1,
  now: number,
) {
  const rows = await ctx.db
    .query("dailySkuMetrics")
    .withIndex("by_productCode_and_serviceDate", (q) =>
      q.eq("productCode", sku.productCode).eq("serviceDate", c.serviceDate),
    )
    .take(MAX_KEY_ROWS * 10);
  const row = rows.find((r) => r.orgUnitId === c.orgUnitId);
  const metrics = addInto(
    row ? pickSkuMetrics(row) : emptySkuMetrics(),
    pickSkuMetrics(sku),
    sign,
  );
  if (isZero(metrics)) {
    if (row) await ctx.db.delete(row._id);
  } else if (row) {
    await ctx.db.patch(row._id, { ...metrics, updatedAt: now });
  } else {
    await ctx.db.insert("dailySkuMetrics", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      serviceDate: c.serviceDate,
      orgUnitId: c.orgUnitId,
      productCode: sku.productCode,
      ...metrics,
      updatedAt: now,
    });
  }
}

async function applyContribution(
  ctx: MutationCtx,
  c: Contribution,
  sign: 1 | -1,
) {
  const now = Date.now();
  let buyingDelta = 0;
  if (c.customerCode !== undefined)
    buyingDelta = await applyCustomer(
      ctx,
      { ...c, customerCode: c.customerCode },
      sign,
      now,
    );
  if (c.territoryId !== undefined)
    await applyTerritory(
      ctx,
      { ...c, territoryId: c.territoryId },
      sign,
      buyingDelta,
      now,
    );
  for (const sku of c.skus) await applySku(ctx, c, sku, sign, now);
}

function storedContribution(row: Doc<"rollupContributions">): Contribution {
  return {
    serviceDate: row.serviceDate,
    orgUnitId: row.orgUnitId,
    territoryId: row.territoryId,
    customerCode: row.customerCode,
    customerId: row.customerId,
    metrics: pickMetrics(row.metrics),
    skus: row.skus,
    complete: row.complete,
  };
}

/**
 * Recomputes one source's contribution and moves the daily rows from the old figures to
 * the new ones. Idempotent. Returns what happened, for tests and backfill counts.
 */
export async function refreshSource(
  ctx: MutationCtx,
  kind: SourceKind,
  sourceId: string,
): Promise<"unchanged" | "updated" | "removed" | "none"> {
  const next = await computeContribution(ctx, kind, sourceId);
  const existing = await ctx.db
    .query("rollupContributions")
    .withIndex("by_sourceKind_and_sourceId", (q) =>
      q.eq("sourceKind", kind).eq("sourceId", sourceId),
    )
    .unique();
  const prev = existing ? storedContribution(existing) : null;
  if (!existing && !next) return "none";
  if (existing?.version === ROLLUP_VERSION && sameContribution(prev, next))
    return "unchanged";
  if (prev) await applyContribution(ctx, prev, -1);
  if (!next) {
    await ctx.db.delete(existing!._id);
    return "removed";
  }
  await applyContribution(ctx, next, 1);
  const doc = {
    sourceKind: kind,
    sourceId,
    ...next,
    version: ROLLUP_VERSION,
    computedAt: Date.now(),
  };
  if (existing) await ctx.db.replace(existing._id, doc);
  else await ctx.db.insert("rollupContributions", doc);
  return "updated";
}

/* ----------------------------------- queueing ----------------------------------- */

/**
 * Records that a source changed and schedules its refresh, once per pending source. Call
 * inside the writing transaction; costs one indexed read when a refresh is already pending.
 */
export async function queueRollup(
  ctx: MutationCtx,
  kind: SourceKind,
  sourceId: string,
) {
  const now = Date.now();
  const pending = await ctx.db
    .query("rollupRefreshes")
    .withIndex("by_sourceKind_and_sourceId", (q) =>
      q.eq("sourceKind", kind).eq("sourceId", sourceId),
    )
    .first();
  if (pending && now - pending.requestedAt < STALE_REFRESH_MS) return;
  if (pending) await ctx.db.patch(pending._id, { requestedAt: now });
  else
    await ctx.db.insert("rollupRefreshes", {
      sourceKind: kind,
      sourceId,
      requestedAt: now,
    });
  await ctx.scheduler.runAfter(
    REFRESH_DELAY_MS,
    internal.analytics.rollups.refresh,
    { sourceKind: kind, sourceId },
  );
}

/** An order (sale, return, approval decision, void) changed. */
export async function queueOrderRollup(
  ctx: MutationCtx,
  orderId: Id<"orders">,
) {
  await queueRollup(ctx, "order", orderId);
}

/** A visit execution event: queues the visit it belongs to (visit, activity, collection). */
export async function queueVisitEventRollup(
  ctx: MutationCtx,
  event: { entityType: string; entityId: string },
) {
  let visitId: Id<"visitExecutions"> | null = null;
  if (event.entityType === "visit")
    visitId = ctx.db.normalizeId("visitExecutions", event.entityId);
  else if (event.entityType === "activity") {
    const id = ctx.db.normalizeId("visitActivities", event.entityId);
    visitId = id ? ((await ctx.db.get(id))?.visitId ?? null) : null;
  } else if (event.entityType === "collection") {
    const id = ctx.db.normalizeId("fieldCollections", event.entityId);
    visitId = id ? ((await ctx.db.get(id))?.visitId ?? null) : null;
  }
  if (visitId) await queueRollup(ctx, "visit", visitId);
}

/** A coverage plan's planned visits were generated, cancelled or replaced. */
export async function queuePlanRollup(
  ctx: MutationCtx,
  planId: Id<"coveragePlans">,
) {
  await ctx.scheduler.runAfter(
    REFRESH_DELAY_MS,
    internal.analytics.rollups.refreshPlan,
    { planId },
  );
}

/* ------------------------------ scheduled functions ------------------------------ */

const refreshResult = v.union(
  v.literal("unchanged"),
  v.literal("updated"),
  v.literal("removed"),
  v.literal("none"),
);

/** Scheduled refresh of one source; clears its pending marker. A visit also refreshes
 * the planned stop it fulfils, whose "done" figure depends on the visit's state. */
export const refresh = internalMutation({
  args: { sourceKind, sourceId: v.string() },
  returns: refreshResult,
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("rollupRefreshes")
      .withIndex("by_sourceKind_and_sourceId", (q) =>
        q.eq("sourceKind", args.sourceKind).eq("sourceId", args.sourceId),
      )
      .take(10);
    for (const row of pending) await ctx.db.delete(row._id);
    const result = await refreshSource(ctx, args.sourceKind, args.sourceId);
    if (args.sourceKind === "visit") {
      const id = ctx.db.normalizeId("visitExecutions", args.sourceId);
      const visit = id ? await ctx.db.get(id) : null;
      if (visit?.plannedVisitId)
        await refreshSource(ctx, "planned", visit.plannedVisitId);
    }
    return result;
  },
});

/** Refreshes every planned visit of one plan, a page at a time. */
export const refreshPlan = internalMutation({
  args: {
    planId: v.id("coveragePlans"),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ processed: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("plannedVisits")
      .withIndex("by_planId_and_serviceDate", (q) =>
        q.eq("planId", args.planId),
      )
      .paginate({ numItems: PAGE, cursor: args.cursor ?? null });
    for (const row of page.page) await refreshSource(ctx, "planned", row._id);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.analytics.rollups.refreshPlan, {
        planId: args.planId,
        cursor: page.continueCursor,
      });
    return { processed: page.page.length, isDone: page.isDone };
  },
});

/**
 * Rebuilds contributions for a whole source table, a page at a time, scheduling the next
 * page. Idempotent; run once per source after deploy or a ROLLUP_VERSION change:
 * `convex run analytics/rollups:backfill '{"source":"order"}'` (then "visit", "planned").
 */
export const backfill = internalMutation({
  args: {
    source: sourceKind,
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    processed: v.number(),
    updated: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const opts = { numItems: PAGE, cursor: args.cursor ?? null };
    const page =
      args.source === "order"
        ? await ctx.db.query("orders").paginate(opts)
        : args.source === "visit"
          ? await ctx.db.query("visitExecutions").paginate(opts)
          : await ctx.db.query("plannedVisits").paginate(opts);
    let updated = 0;
    for (const row of page.page)
      if ((await refreshSource(ctx, args.source, row._id)) === "updated")
        updated++;
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.analytics.rollups.backfill, {
        source: args.source,
        cursor: page.continueCursor,
      });
    return { processed: page.page.length, updated, isDone: page.isDone };
  },
});

/* ------------------------------------ readers ------------------------------------ */

/**
 * Readers need `report.read` within their organizational scope; cross-scope roles see
 * everything. Field `sales` keep their own figures in the DSR and DAR/ROAR. Returns the
 * readable unit set, or null for cross-scope roles.
 */
async function readerScope(ctx: QueryCtx, targetUnitId?: Id<"orgUnits">) {
  const { profile } = await requireCapability(ctx, "report.read", targetUnitId);
  if (profile.role === "sales")
    throw new ConvexError(
      "Field sales read their own figures in the Daily Sales Report",
    );
  if (CROSS_SCOPE_ROLES.has(profile.role)) return null;
  if (!profile.orgUnitId) return new Set<Id<"orgUnits">>();
  return new Set(await collectScopeUnitIds(ctx, profile.orgUnitId));
}

function inScope(units: Set<Id<"orgUnits">> | null, unit: Id<"orgUnits">) {
  return units === null || units.has(unit);
}

function checkRange(fromDate: string, toDate: string) {
  const from = localDate(fromDate);
  const to = localDate(toDate);
  if (to < from) throw new ConvexError("End date is before start date");
  if ((to - from) / 86_400_000 + 1 > MAX_RANGE_DAYS)
    throw new ConvexError(`At most ${MAX_RANGE_DAYS} days at a time`);
}

const rangeArgs = { fromDate: v.string(), toDate: v.string() };
const territoryRow = schema.doc("dailyTerritoryMetrics");
const customerRow = schema.doc("dailyCustomerMetrics");
const skuRow = schema.doc("dailySkuMetrics");

/** One territory's daily rows between two Manila dates (inclusive), in the caller's scope. */
export const territoryDays = query({
  args: { territoryId: v.id("territories"), ...rangeArgs },
  returns: v.object({ rows: v.array(territoryRow), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    checkRange(args.fromDate, args.toDate);
    const units = await readerScope(ctx);
    const rows = await ctx.db
      .query("dailyTerritoryMetrics")
      .withIndex("by_territoryId_and_serviceDate", (q) =>
        q
          .eq("territoryId", args.territoryId)
          .gte("serviceDate", args.fromDate)
          .lte("serviceDate", args.toDate),
      )
      .take(MAX_RANGE_ROWS + 1);
    return {
      rows: rows
        .slice(0, MAX_RANGE_ROWS)
        .filter((row) => inScope(units, row.orgUnitId)),
      truncated: rows.length > MAX_RANGE_ROWS,
    };
  },
});

/** One customer account's daily rows between two Manila dates, in the caller's scope. */
export const customerDays = query({
  args: { customerCode: v.string(), ...rangeArgs },
  returns: v.object({ rows: v.array(customerRow), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    checkRange(args.fromDate, args.toDate);
    const units = await readerScope(ctx);
    const rows = await ctx.db
      .query("dailyCustomerMetrics")
      .withIndex("by_customerCode_and_serviceDate", (q) =>
        q
          .eq("customerCode", args.customerCode)
          .gte("serviceDate", args.fromDate)
          .lte("serviceDate", args.toDate),
      )
      .take(MAX_RANGE_ROWS + 1);
    return {
      rows: rows
        .slice(0, MAX_RANGE_ROWS)
        .filter((row) => inScope(units, row.orgUnitId)),
      truncated: rows.length > MAX_RANGE_ROWS,
    };
  },
});

/** One SKU's daily rows (one per unit and day) between two Manila dates, in scope. */
export const skuDays = query({
  args: { productCode: v.string(), ...rangeArgs },
  returns: v.object({ rows: v.array(skuRow), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    checkRange(args.fromDate, args.toDate);
    const units = await readerScope(ctx);
    const rows = await ctx.db
      .query("dailySkuMetrics")
      .withIndex("by_productCode_and_serviceDate", (q) =>
        q
          .eq("productCode", args.productCode)
          .gte("serviceDate", args.fromDate)
          .lte("serviceDate", args.toDate),
      )
      .take(MAX_RANGE_ROWS + 1);
    return {
      rows: rows
        .slice(0, MAX_RANGE_ROWS)
        .filter((row) => inScope(units, row.orgUnitId)),
      truncated: rows.length > MAX_RANGE_ROWS,
    };
  },
});

const dayArgs = {
  serviceDate: v.string(),
  /** Read one unit's rows directly (must be in scope); otherwise every readable unit. */
  orgUnitId: v.optional(v.id("orgUnits")),
  paginationOpts: paginationOptsValidator,
};

/**
 * Every territory row for one Manila date, paged. Without `orgUnitId`, rows outside the
 * caller's scope are dropped from each page, so a page may come back short or empty while
 * `isDone` is false: keep paging.
 */
export const territoriesForDay = query({
  args: dayArgs,
  returns: paginationResultValidator(territoryRow),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const units = await readerScope(ctx, args.orgUnitId);
    const unit = args.orgUnitId;
    const result = unit
      ? await ctx.db
          .query("dailyTerritoryMetrics")
          .withIndex("by_orgUnitId_and_serviceDate", (q) =>
            q.eq("orgUnitId", unit).eq("serviceDate", args.serviceDate),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("dailyTerritoryMetrics")
          .withIndex("by_organizationId_and_serviceDate", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("serviceDate", args.serviceDate),
          )
          .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.filter((row) => inScope(units, row.orgUnitId)),
    };
  },
});

/** Every customer row for one Manila date, paged (same paging rule as territories). */
export const customersForDay = query({
  args: dayArgs,
  returns: paginationResultValidator(customerRow),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const units = await readerScope(ctx, args.orgUnitId);
    const unit = args.orgUnitId;
    const result = unit
      ? await ctx.db
          .query("dailyCustomerMetrics")
          .withIndex("by_orgUnitId_and_serviceDate", (q) =>
            q.eq("orgUnitId", unit).eq("serviceDate", args.serviceDate),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("dailyCustomerMetrics")
          .withIndex("by_organizationId_and_serviceDate", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("serviceDate", args.serviceDate),
          )
          .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.filter((row) => inScope(units, row.orgUnitId)),
    };
  },
});

/** Every SKU row (per unit) for one Manila date, paged; the web sums units it reads. */
export const skusForDay = query({
  args: dayArgs,
  returns: paginationResultValidator(skuRow),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const units = await readerScope(ctx, args.orgUnitId);
    const unit = args.orgUnitId;
    const result = unit
      ? await ctx.db
          .query("dailySkuMetrics")
          .withIndex("by_orgUnitId_and_serviceDate", (q) =>
            q.eq("orgUnitId", unit).eq("serviceDate", args.serviceDate),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("dailySkuMetrics")
          .withIndex("by_organizationId_and_serviceDate", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("serviceDate", args.serviceDate),
          )
          .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.filter((row) => inScope(units, row.orgUnitId)),
    };
  },
});

export type { RollupMetrics };
