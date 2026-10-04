/* ANA-005 customer execution dashboard: one store's (outlet's) visit regularity, order
 * trend, days since last order, missed planned calls and assortment/distribution status
 * over whole weeks ending on a Manila date. Pure rules live in ./customer_model.ts;
 * meanings in docs/architecture/CUSTOMER_EXECUTION_DASHBOARD.md.
 *
 * Access: supervision readers (`people.read` + `visit.read`, supervision/access.ts) who
 * also hold `report.read`, for stores whose CURRENT owner unit (territory owner, else
 * custodian) is inside their own organizational scope. Never wider.
 *
 * Figures are computed live (customer rollups, CVX-032, do not exist yet). Every read is
 * bounded to one store and at most 13 weeks; the store picker pages the outlet list.
 */
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { localDate } from "../coverage/validation";
import { countsAsSale, manilaDateOf, saleInstant, toMinor } from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { assortmentAt } from "../merchandising/assortments";
import { availabilityStatus } from "../merchandising/validators";
import {
  currentRow,
  outletRows,
  resolveOutletScopeAt,
} from "../outlets/validation";
import { supervisorContext } from "../supervision/access";
import { dayCloseAt, DONE_STATES } from "../supervision/model";
import {
  CUSTOMER_SOURCE,
  customerPeriod,
  daysBetween,
  DEFAULT_CUSTOMER_WEEKS,
  distributionSummary,
  orderTrend,
  plannedCallSummary,
  visitRegularity,
  weekIndex,
  weeksError,
  type AvailabilityStatus,
  type StopFacts,
} from "./customer_model";

/** Visits / planned stops read for one store over 13 weeks (daily visits with headroom). */
const MAX_STORE_ROWS = 400;
/** A customer's orders read newest first; enough for 13 weeks of daily orders. */
const MAX_CUSTOMER_ORDERS = 600;
/** Orders whose lines are read for distribution (newest first). */
const MAX_LINE_ORDERS = 150;
const MAX_LINES_PER_ORDER = 200;
const MAX_MISSED_LISTED = 10;
const MAX_SEARCH = 80;

const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

async function dashboardContext(
  ctx: QueryCtx,
  filters: { serviceDate: string; orgUnitId?: Id<"orgUnits"> },
) {
  const sc = await supervisorContext(ctx, filters);
  await requireCapability(ctx, "report.read");
  return sc;
}

/** Current owner unit of an outlet, or null when its assignment rows are inconsistent. */
async function ownerUnit(ctx: QueryCtx, outletId: Id<"outlets">, now: number) {
  try {
    return await resolveOutletScopeAt(ctx, outletId, now);
  } catch (error) {
    if (error instanceof ConvexError) return null;
    throw error;
  }
}

/**
 * Store picker: one page of the organization's outlets whose current owner unit is in the
 * selected scope, optionally matching a code/name search. A filtered page can be empty
 * while `isDone` is false; the web keeps paging.
 */
export const stores = query({
  args: {
    asOfDate: v.string(),
    orgUnitId: v.optional(v.id("orgUnits")),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        outletId: v.id("outlets"),
        code: v.string(),
        name: v.string(),
        status: v.string(),
        channel: nullableString,
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
    units: v.array(
      v.object({ id: v.id("orgUnits"), code: v.string(), name: v.string() }),
    ),
  }),
  handler: async (ctx, args) => {
    const sc = await dashboardContext(ctx, {
      serviceDate: args.asOfDate,
      ...(args.orgUnitId ? { orgUnitId: args.orgUnitId } : {}),
    });
    const numItems = args.paginationOpts.numItems;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 100)
      throw new ConvexError("Page size must be 1–100");
    const search = (args.search ?? "").trim().toLowerCase();
    if (search.length > MAX_SEARCH) throw new ConvexError("Search is too long");
    const result = await ctx.db
      .query("outlets")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(args.paginationOpts);
    const now = Date.now();
    const page = [];
    for (const outlet of result.page) {
      if (
        search &&
        !outlet.code.toLowerCase().includes(search) &&
        !outlet.name.toLowerCase().includes(search)
      )
        continue;
      const owner = await ownerUnit(ctx, outlet._id, now);
      if (!owner || !sc.units.has(owner.orgUnitId)) continue;
      page.push({
        outletId: outlet._id,
        code: outlet.code,
        name: outlet.name,
        status: outlet.status,
        channel: outlet.channel ?? null,
      });
    }
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      units: sc.unitOptions,
    };
  },
});

const regularity = v.object({
  visitDays: v.number(),
  lastVisitDate: nullableString,
  daysSinceLastVisit: nullableNumber,
  expectedCycleDays: nullableNumber,
  averageGapDays: nullableNumber,
  longestGapDays: nullableNumber,
  gaps: v.number(),
  gapsOnCadence: v.number(),
  onCadencePct: nullableNumber,
  status: v.union(
    v.literal("on_cadence"),
    v.literal("overdue"),
    v.literal("not_visited"),
    v.literal("no_cadence"),
  ),
});

const week = v.object({
  weekStart: v.string(),
  visitDays: v.number(),
  visits: v.number(),
  unplannedVisits: v.number(),
  planned: v.number(),
  plannedDone: v.number(),
  missed: v.number(),
  orders: v.number(),
  /** PHP centavos. */
  sales: v.number(),
});

const sku = v.object({
  productId: v.id("products"),
  code: v.string(),
  name: v.string(),
  ordered: v.boolean(),
  lastOrderedDate: nullableString,
  availability: v.union(availabilityStatus, v.null()),
  facings: nullableNumber,
});

type Week = {
  weekStart: string;
  visitDays: number;
  visits: number;
  unplannedVisits: number;
  planned: number;
  plannedDone: number;
  missed: number;
  orders: number;
  sales: number;
};

/** The store's planned-visit cycle: outlet assignment, else route, else outlet profile. */
async function expectedCycle(
  ctx: QueryCtx,
  outlet: Doc<"outlets">,
  assignment: Doc<"outletAssignments"> | null,
) {
  if (assignment?.cycleDays) return assignment.cycleDays;
  if (assignment?.routeId) {
    const route = await ctx.db.get(assignment.routeId);
    if (route?.cycleDays) return route.cycleDays;
  }
  return outlet.visitFrequencyDays ?? null;
}

/**
 * One store's execution over `weeks` whole weeks (default 12, at most 13) ending on
 * `asOfDate` (Manila). Orders are the store's linked customer's orders: a customer shared
 * by several outlets shows the customer's orders on each of them (flagged).
 */
export const store = query({
  args: {
    outletId: v.id("outlets"),
    asOfDate: v.string(),
    weeks: v.optional(v.number()),
  },
  returns: v.object({
    outlet: v.object({
      outletId: v.id("outlets"),
      code: v.string(),
      name: v.string(),
      status: v.string(),
      channel: nullableString,
      classification: nullableString,
      unitName: nullableString,
      territory: nullableString,
      route: nullableString,
    }),
    customer: v.union(
      v.object({
        code: v.string(),
        name: v.string(),
        sharedWithOtherOutlets: v.boolean(),
      }),
      v.null(),
    ),
    from: v.string(),
    to: v.string(),
    weeks: v.array(week),
    regularity,
    plannedCalls: v.object({
      planned: v.number(),
      done: v.number(),
      missed: v.number(),
      pending: v.number(),
      missedPct: nullableNumber,
      recentMissed: v.array(
        v.object({
          serviceDate: v.string(),
          assigneeName: v.string(),
          route: nullableString,
        }),
      ),
    }),
    orders: v.object({
      orders: v.number(),
      sales: v.number(),
      averageOrder: nullableNumber,
      lastOrderDate: nullableString,
      lastOrderAmount: nullableNumber,
      daysSinceLastOrder: nullableNumber,
      recentSales: v.number(),
      recentOrders: v.number(),
      priorSales: nullableNumber,
      changePct: nullableNumber,
      direction: v.union(
        v.literal("up"),
        v.literal("down"),
        v.literal("steady"),
        v.literal("new"),
        v.literal("none"),
      ),
      skusBought: v.number(),
    }),
    assortment: v.object({
      hasAssortment: v.boolean(),
      required: v.number(),
      ordered: v.number(),
      distributionPct: nullableNumber,
      checked: v.number(),
      available: v.number(),
      outOfStock: v.number(),
      notCarried: v.number(),
      availabilityPct: nullableNumber,
      gaps: v.number(),
      lastAuditDate: nullableString,
      skus: v.array(sku),
    }),
    truncated: v.boolean(),
    sourceRef: v.string(),
  }),
  handler: async (ctx, args) => {
    localDate(args.asOfDate);
    const weekCount = args.weeks ?? DEFAULT_CUSTOMER_WEEKS;
    const weeksProblem = weeksError(weekCount);
    if (weeksProblem) throw new ConvexError(weeksProblem);
    const sc = await dashboardContext(ctx, { serviceDate: args.asOfDate });
    const now = Date.now();
    const scope = await resolveOutletScopeAt(ctx, args.outletId, now);
    if (!sc.scope.has(scope.orgUnitId))
      throw new ConvexError(
        "Requested store is outside your organizational scope",
      );
    const { outlet, assignment } = scope;
    const period = customerPeriod(args.asOfDate, weekCount);
    const weeks: Week[] = period.weekStarts.map((weekStart) => ({
      weekStart,
      visitDays: 0,
      visits: 0,
      unplannedVisits: 0,
      planned: 0,
      plannedDone: 0,
      missed: 0,
      orders: 0,
      sales: 0,
    }));
    let truncated = false;

    // Where the store sits today.
    const unit = await ctx.db.get(scope.orgUnitId);
    const territory = assignment
      ? await ctx.db.get(assignment.territoryId)
      : null;
    const route = assignment?.routeId
      ? await ctx.db.get(assignment.routeId)
      : null;
    const link = currentRow(
      await outletRows(ctx, "outletCustomerLinks", outlet._id),
      now,
    );
    const customer = link ? await ctx.db.get(link.customerId) : null;
    let sharedWithOtherOutlets = false;
    if (customer) {
      const links = await ctx.db
        .query("outletCustomerLinks")
        .withIndex("by_customerId_and_effectiveFrom", (q) =>
          q.eq("customerId", customer._id).lte("effectiveFrom", now),
        )
        .take(50);
      sharedWithOtherOutlets = links.some(
        (row) =>
          row.outletId !== outlet._id &&
          (row.effectiveTo === undefined || row.effectiveTo > now),
      );
    }

    // Visits: regularity and per-week activity.
    const visits = await ctx.db
      .query("visitExecutions")
      .withIndex("by_outletId_and_serviceDate", (q) =>
        q
          .eq("outletId", outlet._id)
          .gte("serviceDate", period.from)
          .lte("serviceDate", period.to),
      )
      .take(MAX_STORE_ROWS + 1);
    if (visits.length > MAX_STORE_ROWS) {
      truncated = true;
      visits.length = MAX_STORE_ROWS;
    }
    const doneVisits = visits.filter(
      (visit) =>
        visit.organizationId === SUNPRIDE_ORGANIZATION_ID &&
        DONE_STATES.has(visit.state),
    );
    const visitDates = new Set<string>();
    for (const visit of doneVisits) {
      const index = weekIndex(period, visit.serviceDate);
      if (index < 0) continue;
      weeks[index]!.visits++;
      if (visit.source === "unplanned") weeks[index]!.unplannedVisits++;
      if (!visitDates.has(visit.serviceDate)) {
        visitDates.add(visit.serviceDate);
        weeks[index]!.visitDays++;
      }
    }
    // The latest visit day before the period, so the first gap is honest.
    const before = await ctx.db
      .query("visitExecutions")
      .withIndex("by_outletId_and_serviceDate", (q) =>
        q.eq("outletId", outlet._id).lt("serviceDate", period.from),
      )
      .order("desc")
      .take(50);
    const lastVisitBefore =
      before.find(
        (visit) =>
          visit.organizationId === SUNPRIDE_ORGANIZATION_ID &&
          DONE_STATES.has(visit.state),
      )?.serviceDate ?? null;
    const regularityFacts = visitRegularity({
      visitDates: [...visitDates],
      lastVisitBefore,
      asOfDate: args.asOfDate,
      expectedCycleDays: await expectedCycle(ctx, outlet, assignment),
    });

    // Planned stops of the signed MCP: done, missed, still due.
    const stops = (
      await ctx.db
        .query("plannedVisits")
        .withIndex("by_outletId_and_serviceDate", (q) =>
          q
            .eq("outletId", outlet._id)
            .gte("serviceDate", period.from)
            .lte("serviceDate", period.to),
        )
        .take(MAX_STORE_ROWS + 1)
    ).filter((stop) => stop.status === "planned");
    if (stops.length > MAX_STORE_ROWS) {
      truncated = true;
      stops.length = MAX_STORE_ROWS;
    }
    const doneStops = new Set(
      doneVisits.flatMap((visit) =>
        visit.plannedVisitId ? [visit.plannedVisitId as string] : [],
      ),
    );
    const stopFacts: (StopFacts & { stop: Doc<"plannedVisits"> })[] = stops.map(
      (stop) => ({
        stop,
        serviceDate: stop.serviceDate,
        closed: dayCloseAt(stop.serviceDate) < now,
        done: doneStops.has(stop._id),
      }),
    );
    for (const fact of stopFacts) {
      const index = weekIndex(period, fact.serviceDate);
      if (index < 0) continue;
      weeks[index]!.planned++;
      if (fact.done) weeks[index]!.plannedDone++;
      else if (fact.closed) weeks[index]!.missed++;
    }
    const names = new Map<Id<"profiles">, string>();
    const recentMissed = [];
    for (const fact of stopFacts
      .filter((row) => !row.done && row.closed)
      .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate))
      .slice(0, MAX_MISSED_LISTED)) {
      const assignee = fact.stop.assigneeProfileId;
      if (!names.has(assignee))
        names.set(
          assignee,
          (await ctx.db.get(assignee))?.name ?? "Former user",
        );
      recentMissed.push({
        serviceDate: fact.serviceDate,
        assigneeName: names.get(assignee)!,
        route: fact.stop.approvedSnapshot.routeCode ?? null,
      });
    }

    // Orders of the store's customer (DSR sale rule, Manila day written).
    let periodOrders = 0;
    let periodSales = 0;
    let positiveOrders = 0;
    let positiveSales = 0;
    let lastOrder: { date: string; instant: number; amount: number } | null =
      null;
    const lineOrders: { id: Id<"orders">; date: string }[] = [];
    if (customer) {
      const orders = await ctx.db
        .query("orders")
        .withIndex("by_customer", (q) => q.eq("customerCode", customer.code))
        .order("desc")
        .take(MAX_CUSTOMER_ORDERS + 1);
      if (orders.length > MAX_CUSTOMER_ORDERS) {
        orders.length = MAX_CUSTOMER_ORDERS;
        const oldest = orders[orders.length - 1]!;
        if (manilaDateOf(saleInstant(oldest)) >= period.from) truncated = true;
      }
      for (const order of orders) {
        if (
          (order.organizationId !== undefined &&
            order.organizationId !== SUNPRIDE_ORGANIZATION_ID) ||
          !countsAsSale(order.status)
        )
          continue;
        const instant = saleInstant(order);
        const date = manilaDateOf(instant);
        if (date > args.asOfDate) continue;
        const amount = toMinor(order.total);
        // A return (negative order) reduces sales but is never "the last order".
        if (order.total > 0 && (!lastOrder || instant > lastOrder.instant))
          lastOrder = { date, instant, amount };
        const index = weekIndex(period, date);
        if (index < 0) continue;
        weeks[index]!.orders++;
        weeks[index]!.sales += amount;
        periodOrders++;
        periodSales += amount;
        if (order.total > 0) {
          positiveOrders++;
          positiveSales += amount;
          lineOrders.push({ id: order._id, date });
        }
      }
    }
    lineOrders.sort((a, b) => b.date.localeCompare(a.date));
    if (lineOrders.length > MAX_LINE_ORDERS) {
      truncated = true;
      lineOrders.length = MAX_LINE_ORDERS;
    }
    const lastOrderedByCode = new Map<string, string>();
    for (const order of lineOrders) {
      const lines = await ctx.db
        .query("orderLines")
        .withIndex("by_order", (q) => q.eq("orderId", order.id))
        .take(MAX_LINES_PER_ORDER);
      for (const line of lines) {
        if (line.quantity <= 0) continue;
        const seen = lastOrderedByCode.get(line.productCode);
        if (!seen || order.date > seen)
          lastOrderedByCode.set(line.productCode, order.date);
      }
    }
    const trend = orderTrend(weeks);

    // Required assortment against orders and the latest merchandising audit.
    const assortment = await assortmentAt(ctx, outlet._id, now);
    const audit = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_outletId_and_serviceDate", (q) =>
        q.eq("outletId", outlet._id).lte("serviceDate", args.asOfDate),
      )
      .order("desc")
      .first();
    const availability = new Map<
      Id<"products">,
      { status: AvailabilityStatus; facings: number | null }
    >();
    if (audit) {
      const rows = await ctx.db
        .query("merchandisingAvailability")
        .withIndex("by_auditId", (q) => q.eq("auditId", audit._id))
        .take(MAX_LINES_PER_ORDER);
      for (const row of rows)
        availability.set(row.productId, {
          status: row.status,
          facings: row.facings ?? null,
        });
    }
    const skus = [];
    for (const productId of assortment?.productIds ?? []) {
      const product = await ctx.db.get(productId);
      const code = product?.code ?? "—";
      const lastOrderedDate = product
        ? (lastOrderedByCode.get(product.code) ?? null)
        : null;
      const found = availability.get(productId);
      skus.push({
        productId,
        code,
        name: product?.name ?? "Unknown product",
        ordered: lastOrderedDate !== null,
        lastOrderedDate,
        availability: found?.status ?? null,
        facings: found?.facings ?? null,
      });
    }
    skus.sort((a, b) => a.code.localeCompare(b.code));
    const distribution = distributionSummary(skus);

    return {
      outlet: {
        outletId: outlet._id,
        code: outlet.code,
        name: outlet.name,
        status: outlet.status,
        channel: outlet.channel ?? null,
        classification: outlet.classification ?? null,
        unitName: unit?.name ?? null,
        territory: territory ? `${territory.code} · ${territory.name}` : null,
        route: route ? route.code : null,
      },
      customer: customer
        ? {
            code: customer.code,
            name: customer.name,
            sharedWithOtherOutlets,
          }
        : null,
      from: period.from,
      to: period.to,
      weeks,
      regularity: regularityFacts,
      plannedCalls: { ...plannedCallSummary(stopFacts), recentMissed },
      orders: {
        orders: periodOrders,
        sales: periodSales,
        averageOrder: positiveOrders
          ? Math.round(positiveSales / positiveOrders)
          : null,
        lastOrderDate: lastOrder?.date ?? null,
        lastOrderAmount: lastOrder?.amount ?? null,
        daysSinceLastOrder: lastOrder
          ? daysBetween(lastOrder.date, args.asOfDate)
          : null,
        ...trend,
        skusBought: lastOrderedByCode.size,
      },
      assortment: {
        hasAssortment: assortment !== null,
        ...distribution,
        lastAuditDate: audit?.serviceDate ?? null,
        skus,
      },
      truncated,
      sourceRef: CUSTOMER_SOURCE,
    };
  },
});
