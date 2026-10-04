/* ANA-009 suggested order (ICO) engine v1 for one store. Pure rules live in
 * ./suggested_order_model.ts; meanings in docs/architecture/SUGGESTED_ORDER_ENGINE.md.
 *
 * Access: `outlet.read` for the store (a salesperson only for stores in a territory they
 * are currently assigned to) plus `report.read` in the store's current owner unit. The
 * optional selling location needs `inventory.read` in the location's unit.
 *
 * Every read is bounded: one store, one customer's last 84 days of orders, its visits and
 * the latest merchandising audit in that window, and at most MAX_SKUS products.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { localDate, manilaDate } from "../coverage/validation";
import { countsAsSale, manilaDateOf, saleInstant } from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import { requireNationalScope } from "../lib/scope";
import { assortmentAt, usableProduct } from "../merchandising/assortments";
import { activeAt, prospective } from "../org/validation";
import {
  currentRow,
  outletRows,
  requireOutletCapability,
} from "../outlets/validation";
import { boundedText } from "../visits/validation";
import {
  daysToNextVisit,
  DEFAULT_LEAD_TIME_DAYS,
  historyDays,
  historyFrom,
  leadTimeError,
  lineStatus,
  nextVisitSource,
  overlaps,
  sortLines,
  stockSource,
  SUGGESTED_ORDER_SOURCE,
  SUGGESTED_ORDER_VERSION,
  suggestLine,
  upliftError,
  type SkuFacts,
  type StockObservation,
} from "./suggested_order_model";

const MAX_CUSTOMER_ORDERS = 400;
const MAX_LINE_ORDERS = 150;
const MAX_LINES_PER_ORDER = 200;
const MAX_VISITS = 150;
const MAX_ACTIVITIES_PER_VISIT = 200;
const MAX_SKUS = 200;
const MAX_PROMOTION_HISTORY = 200;

const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

const line = v.object({
  productId: v.union(v.id("products"), v.null()),
  code: v.string(),
  name: v.string(),
  unit: v.string(),
  required: v.boolean(),
  status: lineStatus,
  suggestedQuantity: v.number(),
  icoQuantity: v.number(),
  dailyDemand: v.number(),
  historyQuantity: v.number(),
  lastPurchaseDate: nullableString,
  daysSinceLastPurchase: nullableNumber,
  storeStock: v.number(),
  stockSource,
  promotion: v.union(
    v.object({ programRef: v.string(), upliftPct: v.number() }),
    v.null(),
  ),
  available: nullableNumber,
  cappedByAvailability: v.boolean(),
  reasons: v.array(v.string()),
});

/** The store's visit cycle: outlet assignment, else route, else outlet profile. */
async function cycleDays(
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

/** The promotion uplift active for a product at `at`, if any. */
export async function activePromotion(
  ctx: QueryCtx,
  productId: Id<"products">,
  at: number,
) {
  const latest = await ctx.db
    .query("suggestedOrderPromotions")
    .withIndex("by_organizationId_and_productId_and_effectiveFrom", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", productId)
        .lte("effectiveFrom", at),
    )
    .order("desc")
    .first();
  return latest && activeAt(latest.effectiveFrom, latest.effectiveTo, at)
    ? latest
    : null;
}

/** Whether a stored quantity is in the product's selling unit (`products.uom`). */
function sameUnit(product: Doc<"products">, uom: Doc<"unitsOfMeasure"> | null) {
  return uom !== null && uom.code.toUpperCase() === product.uom.toUpperCase();
}

/**
 * Suggested order for one store on `asOfDate` (Manila, today or earlier). Selling-location
 * availability is today's balance; pass `locationId` (the depot or truck the store is sold
 * from) to cap suggestions by it, else availability is reported unknown.
 */
export const forOutlet = query({
  args: {
    outletId: v.id("outlets"),
    asOfDate: v.string(),
    locationId: v.optional(v.id("inventoryLocations")),
    leadTimeDays: v.optional(v.number()),
  },
  returns: v.object({
    version: v.string(),
    sourceRef: v.string(),
    outlet: v.object({
      outletId: v.id("outlets"),
      code: v.string(),
      name: v.string(),
    }),
    customer: v.union(
      v.object({ code: v.string(), name: v.string() }),
      v.null(),
    ),
    asOfDate: v.string(),
    historyFrom: v.string(),
    historyDays: v.number(),
    nextVisit: v.object({
      days: v.number(),
      source: nextVisitSource,
      date: nullableString,
    }),
    leadTimeDays: v.number(),
    leadTimeProvisional: v.boolean(),
    coverDays: v.number(),
    location: v.union(
      v.object({
        locationId: v.id("inventoryLocations"),
        code: v.string(),
        name: v.string(),
      }),
      v.null(),
    ),
    lines: v.array(line),
    totals: v.object({
      skus: v.number(),
      suggestedSkus: v.number(),
      suggestedQuantity: v.number(),
      cappedSkus: v.number(),
    }),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    localDate(args.asOfDate);
    const now = Date.now();
    const today = manilaDate(now);
    if (args.asOfDate > today)
      throw new ConvexError("Suggested orders cannot be dated in the future");
    const leadTimeDays = args.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
    const leadProblem = leadTimeError(leadTimeDays);
    if (leadProblem) throw new ConvexError(leadProblem);

    const scope = await requireOutletCapability(
      ctx,
      "outlet.read",
      args.outletId,
    );
    const { profile } = await requireCapability(
      ctx,
      "report.read",
      scope.orgUnitId,
    );
    const { outlet, assignment } = scope;

    // Selling location: scoped to the caller like every inventory read.
    let location: Doc<"inventoryLocations"> | null = null;
    if (args.locationId) {
      location = await ctx.db.get(args.locationId);
      if (
        !location ||
        location.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
        !location.active ||
        !location.allowsSale
      )
        throw new ConvexError("Selling location not found");
      if (location.orgUnitId)
        await requireCapability(ctx, "inventory.read", location.orgUnitId);
      else if (profile.role === "super_admin" || profile.role === "analyst")
        await requireCapability(ctx, "inventory.read");
      else
        throw new ConvexError(
          "Selling location has no organizational unit; ask an administrator to map it",
        );
    }

    let truncated = false;
    const from = historyFrom(args.asOfDate);
    // Promotions, like availability, are read for the instant the order is written.
    const promotionAt =
      args.asOfDate === today
        ? now
        : Date.parse(`${args.asOfDate}T12:00:00+08:00`);

    const link = currentRow(
      await outletRows(ctx, "outletCustomerLinks", outlet._id),
      now,
    );
    const customer = link ? await ctx.db.get(link.customerId) : null;

    // Orders of the store's customer in the window (DSR sale rule, Manila day written).
    type Bought = {
      quantity: number;
      lastDate: string | null;
      lastQuantity: number;
    };
    const bought = new Map<string, Bought>();
    let firstOrderDate: string | null = null;
    if (customer) {
      const orders = await ctx.db
        .query("orders")
        .withIndex("by_customer", (q) => q.eq("customerCode", customer.code))
        .order("desc")
        .take(MAX_CUSTOMER_ORDERS + 1);
      if (orders.length > MAX_CUSTOMER_ORDERS) {
        orders.length = MAX_CUSTOMER_ORDERS;
        const oldest = orders[orders.length - 1]!;
        if (manilaDateOf(saleInstant(oldest)) >= from) truncated = true;
      }
      const inWindow = orders
        .filter(
          (order) =>
            (order.organizationId === undefined ||
              order.organizationId === SUNPRIDE_ORGANIZATION_ID) &&
            countsAsSale(order.status) &&
            order.total > 0,
        )
        .map((order) => ({ order, date: manilaDateOf(saleInstant(order)) }))
        .filter((row) => row.date >= from && row.date <= args.asOfDate)
        // Oldest first so the last purchase of each SKU wins.
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            saleInstant(a.order) - saleInstant(b.order),
        );
      firstOrderDate = inWindow[0]?.date ?? null;
      if (inWindow.length > MAX_LINE_ORDERS) {
        truncated = true;
        inWindow.splice(0, inWindow.length - MAX_LINE_ORDERS);
      }
      for (const { order, date } of inWindow) {
        const lines = await ctx.db
          .query("orderLines")
          .withIndex("by_order", (q) => q.eq("orderId", order._id))
          .take(MAX_LINES_PER_ORDER + 1);
        if (lines.length > MAX_LINES_PER_ORDER) {
          truncated = true;
          lines.length = MAX_LINES_PER_ORDER;
        }
        // One order's quantity per SKU, so its last purchase is the whole order line set.
        const perOrder = new Map<string, number>();
        for (const row of lines)
          if (row.quantity > 0)
            perOrder.set(
              row.productCode,
              (perOrder.get(row.productCode) ?? 0) + row.quantity,
            );
        for (const [code, quantity] of perOrder) {
          const seen = bought.get(code) ?? {
            quantity: 0,
            lastDate: null,
            lastQuantity: 0,
          };
          seen.quantity += quantity;
          if (seen.lastDate === date) seen.lastQuantity += quantity;
          else {
            seen.lastDate = date;
            seen.lastQuantity = quantity;
          }
          bought.set(code, seen);
        }
      }
    }

    // Candidate SKUs: everything bought in the window plus the required assortment.
    const assortment = await assortmentAt(ctx, outlet._id, now);
    const products = new Map<string, Doc<"products">>();
    const required = new Set<string>();
    for (const productId of assortment?.productIds ?? []) {
      const product = await ctx.db.get(productId);
      if (!product || !usableProduct(product)) continue;
      products.set(product.code, product);
      required.add(product.code);
    }
    const codes = [...new Set([...required, ...bought.keys()])].sort();
    if (codes.length > MAX_SKUS) {
      truncated = true;
      codes.length = MAX_SKUS;
    }
    for (const code of codes) {
      if (products.has(code)) continue;
      const product = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (
        product &&
        (!product.organizationId ||
          product.organizationId === SUNPRIDE_ORGANIZATION_ID)
      )
        products.set(code, product);
    }

    // Store observations in the window: counted quantities from visit inventory checks
    // and out-of-stock / not-carried findings from the latest merchandising audit.
    const observations = new Map<Id<"products">, StockObservation>();
    const keepLatest = (productId: Id<"products">, obs: StockObservation) => {
      const seen = observations.get(productId);
      if (!seen || obs.date >= seen.date) observations.set(productId, obs);
    };
    const visits = (
      await ctx.db
        .query("visitExecutions")
        .withIndex("by_outletId_and_serviceDate", (q) =>
          q
            .eq("outletId", outlet._id)
            .gte("serviceDate", from)
            .lte("serviceDate", args.asOfDate),
        )
        .order("desc")
        .take(MAX_VISITS + 1)
    ).filter((visit) => visit.organizationId === SUNPRIDE_ORGANIZATION_ID);
    if (visits.length > MAX_VISITS) {
      truncated = true;
      visits.length = MAX_VISITS;
    }
    const units = new Map<Id<"unitsOfMeasure">, Doc<"unitsOfMeasure"> | null>();
    const productsById = new Map(
      [...products.values()].map((product) => [product._id, product]),
    );
    // Oldest visit first; activities in server order, so a later count replaces an earlier.
    for (const visit of [...visits].reverse()) {
      const activities = await ctx.db
        .query("visitActivities")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_ACTIVITIES_PER_VISIT);
      for (const row of activities) {
        const activity = row.activity;
        if (activity.kind !== "inventory_check") continue;
        const product = productsById.get(activity.productId);
        if (!product) continue;
        if (activity.observedQuantity !== undefined) {
          if (activity.uomId) {
            if (!units.has(activity.uomId))
              units.set(activity.uomId, await ctx.db.get(activity.uomId));
            if (!sameUnit(product, units.get(activity.uomId)!)) continue;
          }
          keepLatest(product._id, {
            date: visit.serviceDate,
            quantity: Math.max(0, activity.observedQuantity),
            source: "counted",
          });
        } else if (activity.icoFinding === "absent")
          keepLatest(product._id, {
            date: visit.serviceDate,
            quantity: 0,
            source: "reported_out",
          });
      }
    }
    const audit = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_outletId_and_serviceDate", (q) =>
        q
          .eq("outletId", outlet._id)
          .gte("serviceDate", from)
          .lte("serviceDate", args.asOfDate),
      )
      .order("desc")
      .first();
    if (audit) {
      const rows = await ctx.db
        .query("merchandisingAvailability")
        .withIndex("by_auditId", (q) => q.eq("auditId", audit._id))
        .take(MAX_SKUS);
      for (const row of rows)
        if (row.status === "out_of_stock" || row.status === "not_carried")
          if (productsById.has(row.productId)) {
            const seen = observations.get(row.productId);
            // A count on the same day is more precise than an audit finding.
            if (!seen || seen.date < row.serviceDate)
              observations.set(row.productId, {
                date: row.serviceDate,
                quantity: 0,
                source: "reported_out",
              });
          }
    }

    // Next visit: the next signed MCP stop, else the store's cycle.
    const nextStop = (
      await ctx.db
        .query("plannedVisits")
        .withIndex("by_outletId_and_serviceDate", (q) =>
          q.eq("outletId", outlet._id).gt("serviceDate", args.asOfDate),
        )
        .take(30)
    ).find((stop) => stop.status === "planned");
    const nextVisit = daysToNextVisit({
      asOfDate: args.asOfDate,
      nextStopDate: nextStop?.serviceDate ?? null,
      cycleDays: await cycleDays(ctx, outlet, assignment),
    });
    const settings = {
      asOfDate: args.asOfDate,
      historyDays: historyDays(firstOrderDate, args.asOfDate),
      nextVisitDays: nextVisit.days,
      leadTimeDays,
      coverDays: nextVisit.days + leadTimeDays,
    };

    const lines = [];
    for (const code of codes) {
      const product = products.get(code) ?? null;
      const history = bought.get(code);
      const promotion = product
        ? await activePromotion(ctx, product._id, promotionAt)
        : null;
      let available: number | null = null;
      if (location && product) {
        const balance = await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("locationId", location._id)
              .eq("productId", product._id),
          )
          .first();
        // Balances count the base unit; only trust them when it is the selling unit.
        const base = product.baseUomId
          ? await ctx.db.get(product.baseUomId)
          : null;
        if (!product.baseUomId || sameUnit(product, base))
          available = balance ? balance.available : 0;
      }
      const facts: SkuFacts = {
        code,
        unit: product?.uom ?? "unit",
        historyQuantity: history?.quantity ?? 0,
        lastPurchaseDate: history?.lastDate ?? null,
        lastPurchaseQuantity: history ? history.lastQuantity : null,
        observation: product ? (observations.get(product._id) ?? null) : null,
        promotion: promotion
          ? { programRef: promotion.programRef, upliftPct: promotion.upliftPct }
          : null,
        available,
      };
      const suggestion = suggestLine(facts, settings);
      if (location && product && available === null)
        suggestion.reasons.push(
          "Depot stock is kept in another unit, so it was not checked",
        );
      lines.push({
        ...suggestion,
        productId: product?._id ?? null,
        name: product?.name ?? "Unknown product",
        required: required.has(code),
        lastPurchaseDate: facts.lastPurchaseDate,
      });
    }
    const sorted = sortLines(lines);
    const suggested = sorted.filter((row) => row.suggestedQuantity > 0);
    return {
      version: SUGGESTED_ORDER_VERSION,
      sourceRef: SUGGESTED_ORDER_SOURCE,
      outlet: { outletId: outlet._id, code: outlet.code, name: outlet.name },
      customer: customer ? { code: customer.code, name: customer.name } : null,
      asOfDate: args.asOfDate,
      historyFrom: from,
      historyDays: settings.historyDays,
      nextVisit,
      leadTimeDays,
      leadTimeProvisional: args.leadTimeDays === undefined,
      coverDays: settings.coverDays,
      location: location
        ? {
            locationId: location._id,
            code: location.code,
            name: location.name,
          }
        : null,
      lines: sorted,
      totals: {
        skus: sorted.length,
        suggestedSkus: suggested.length,
        suggestedQuantity: suggested.reduce(
          (sum, row) => sum + row.suggestedQuantity,
          0,
        ),
        cappedSkus: sorted.filter((row) => row.cappedByAvailability).length,
      },
      truncated,
    };
  },
});

const promotionRow = v.object({
  promotionId: v.id("suggestedOrderPromotions"),
  productId: v.id("products"),
  programRef: v.string(),
  upliftPct: v.number(),
  effectiveFrom: v.number(),
  effectiveTo: v.union(v.number(), v.null()),
  sourceRef: v.string(),
});

async function promotionHistory(ctx: QueryCtx, productId: Id<"products">) {
  const rows = await ctx.db
    .query("suggestedOrderPromotions")
    .withIndex("by_organizationId_and_productId_and_effectiveFrom", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", productId),
    )
    .take(MAX_PROMOTION_HISTORY + 1);
  if (rows.length > MAX_PROMOTION_HISTORY)
    throw new ConvexError("Promotion history exceeds limit");
  return rows;
}

/** A SKU's promotion uplifts, oldest first. National rows; any report reader. */
export const promotions = query({
  args: { productId: v.id("products") },
  returns: v.array(promotionRow),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "report.read");
    const rows = await promotionHistory(ctx, args.productId);
    return rows.map((row) => ({
      promotionId: row._id,
      productId: row.productId,
      programRef: row.programRef,
      upliftPct: row.upliftPct,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo ?? null,
      sourceRef: row.sourceRef,
    }));
  },
});

/**
 * Schedules a promotion uplift for one SKU nationwide. Future-effective only; never
 * overlaps another uplift for the same SKU.
 */
export const schedulePromotion = mutation({
  args: {
    productId: v.id("products"),
    programRef: v.string(),
    upliftPct: v.number(),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    sourceRef: v.string(),
  },
  returns: v.id("suggestedOrderPromotions"),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(
      ctx,
      capabilityRoles("masterdata.manage"),
    );
    const product = await ctx.db.get(args.productId);
    if (!usableProduct(product)) throw new ConvexError("Product not found");
    const programRef = boundedText(args.programRef, 80);
    const sourceRef = boundedText(args.sourceRef, 200);
    const problem = upliftError(args.upliftPct);
    if (problem) throw new ConvexError(problem);
    prospective(args.effectiveFrom);
    if (
      args.effectiveTo !== undefined &&
      !(
        Number.isFinite(args.effectiveTo) &&
        args.effectiveTo > args.effectiveFrom
      )
    )
      throw new ConvexError("A promotion must end after it starts");
    const existing = await promotionHistory(ctx, args.productId);
    if (existing.some((row) => overlaps(row, args)))
      throw new ConvexError(
        "This product already has a promotion uplift in that period",
      );
    const now = Date.now();
    return await ctx.db.insert("suggestedOrderPromotions", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productId: args.productId,
      programRef,
      upliftPct: args.upliftPct,
      effectiveFrom: args.effectiveFrom,
      ...(args.effectiveTo !== undefined
        ? { effectiveTo: args.effectiveTo }
        : {}),
      sourceRef,
      actorSubject: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Ends a promotion uplift earlier, from a future instant. */
export const endPromotion = mutation({
  args: {
    promotionId: v.id("suggestedOrderPromotions"),
    effectiveTo: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNationalScope(ctx, capabilityRoles("masterdata.manage"));
    const row = await ctx.db.get(args.promotionId);
    if (!row || row.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Promotion not found");
    prospective(args.effectiveTo);
    if (args.effectiveTo <= row.effectiveFrom)
      throw new ConvexError("A promotion must end after it starts");
    if (row.effectiveTo !== undefined && row.effectiveTo <= args.effectiveTo)
      throw new ConvexError("The promotion already ends by then");
    await ctx.db.patch(row._id, {
      effectiveTo: args.effectiveTo,
      updatedAt: Date.now(),
    });
    return null;
  },
});
