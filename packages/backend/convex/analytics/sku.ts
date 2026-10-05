import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { localDate } from "../coverage/validation";
import { LATE_ORDER_WINDOW_MS, saleInstant } from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { MAX_AVAILABILITY_LINES } from "../merchandising/validators";
import { orderScopeCheck } from "../mobile/account_summary";
import { activeAt } from "../org/validation";
import { resolveOutletScopeAt } from "../outlets/validation";
import {
  supervisorContext,
  type SupervisorContext,
} from "../supervision/access";
import { resolveTerritoryOwnerAt } from "../territories/validation";
import { MAX_ORDER_LINES, orderFigures } from "./rollups_model";
import {
  addShelfStatus,
  emptySkuFigures,
  SKU_SOURCE,
  sortGapOutlets,
  type ShelfStatus,
  type SkuFigures,
} from "./sku_model";
import { periodError } from "./territory_model";

/**
 * ANA-006 SKU distribution dashboard. `territory` returns, for one territory and period,
 * every SKU sold or audited there: buying stores, distribution gaps, sales and the shelf
 * signals of the latest merchandising audits. `gaps` lists one SKU's gap stores. The web
 * lists territories through `analytics/territory:list` and subscribes one read per
 * territory, then sums territories into SKU totals and territory / channel splits.
 *
 * Access: as ANA-004 — supervision readers (`people.read` + `visit.read`) who also hold
 * `report.read`, inside their own organizational scope. Field `sales` never sees it.
 * Historical store membership never widens access: each store must also sit in the
 * caller's CURRENT scope through its current persisted owner (territory owner, else
 * custodian), and each order counts only when its author and source location are in
 * scope — a shared accounting customer is never an access key.
 *
 * Computed live from the source tables: `dailySkuMetrics` (CVX-032) has no store
 * dimension, so it cannot count buying stores. Pure rules: `./sku_model.ts`.
 */

const DAY = 86_400_000;
const MAX_OUTLET_ROWS = 300;
const MAX_ASSIGNMENT_HISTORY = 1_500;
const MAX_HISTORY = 50;
const MAX_CUSTOMER_ORDERS = 1_000;
/** Order lines read in one territory read. */
const MAX_LINES_READ = 6_000;
const MAX_SKUS = 400;
const MAX_GAP_OUTLETS = 25;

const TOO_BIG =
  "This territory has too much activity for one read; pick a shorter period";

const shelfStatus = v.union(
  v.literal("available"),
  v.literal("low_stock"),
  v.literal("out_of_stock"),
  v.literal("not_carried"),
);

const skuFiguresValidator = v.object({
  buyingOutlets: v.number(),
  orders: v.number(),
  quantity: v.number(),
  salesMinor: v.number(),
  returnQuantity: v.number(),
  returnsMinor: v.number(),
  auditedOutlets: v.number(),
  onShelfOutlets: v.number(),
  lowStockOutlets: v.number(),
  outOfStockOutlets: v.number(),
  notCarriedOutlets: v.number(),
});

async function context(ctx: QueryCtx, serviceDate: string) {
  const sc = await supervisorContext(ctx, { serviceDate });
  await requireCapability(ctx, "report.read");
  return sc;
}

async function loadTerritory(
  ctx: QueryCtx,
  territoryId: Id<"territories">,
  from: string,
  to: string,
) {
  localDate(from);
  localDate(to);
  const error = periodError(from, to);
  if (error) throw new ConvexError(error);
  const sc = await context(ctx, to);
  const territory = await ctx.db.get(territoryId);
  if (!territory || territory.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Territory not found");
  let ownerUnit: Id<"orgUnits"> | null = null;
  try {
    ownerUnit =
      (await resolveTerritoryOwnerAt(ctx, territory._id, Date.now()))
        ?.orgUnitId ?? null;
  } catch {
    // Broken ownership history is an admin problem; it never widens access.
  }
  if (!ownerUnit || !sc.scope.has(ownerUnit))
    throw new ConvexError(
      "Requested territory is outside your organizational scope",
    );
  return { territory, sc };
}

type Product = { code: string; name: string; category: string };

/**
 * Everything the two queries need for one territory and period: its active stores at the
 * end of the period, which of them bought each SKU (and the SKU's sales), and each store's
 * latest audited shelf status per SKU.
 */
async function territoryData(
  ctx: QueryCtx,
  sc: SupervisorContext,
  territory: Doc<"territories">,
  from: string,
  to: string,
) {
  const now = Date.now();
  const start = localDate(from);
  const end = localDate(to) + DAY;

  const history = await ctx.db
    .query("outletAssignments")
    .withIndex("by_territoryId_and_effectiveFrom", (q) =>
      q.eq("territoryId", territory._id).lt("effectiveFrom", end),
    )
    .take(MAX_ASSIGNMENT_HISTORY + 1);
  if (history.length > MAX_ASSIGNMENT_HISTORY) throw new ConvexError(TOO_BIG);
  const byOutlet = new Map<Id<"outlets">, Doc<"outletAssignments">[]>();
  for (const row of history)
    if (
      (row.effectiveTo === undefined || row.effectiveTo > start) &&
      row.effectiveTo !== row.effectiveFrom
    )
      byOutlet.set(row.outletId, [...(byOutlet.get(row.outletId) ?? []), row]);
  if (byOutlet.size > MAX_OUTLET_ROWS) throw new ConvexError(TOO_BIG);
  // A store that has since moved out of the caller's scope is dropped from every figure,
  // even for days it belonged to this territory.
  for (const outletId of [...byOutlet.keys()]) {
    let unit: Id<"orgUnits"> | null = null;
    try {
      unit = (await resolveOutletScopeAt(ctx, outletId, now)).orgUnitId;
    } catch {
      // Broken or missing ownership never widens access.
    }
    if (!unit || !sc.scope.has(unit)) byOutlet.delete(outletId);
  }
  const inScope = orderScopeCheck(ctx, {
    subject: sc.profile.authSubject,
    role: sc.profile.role,
    units: sc.scope,
  });
  const inTerritoryAt = (outletId: Id<"outlets">, instant: number) =>
    (byOutlet.get(outletId) ?? []).some((row) =>
      activeAt(row.effectiveFrom, row.effectiveTo, instant),
    );

  // Active stores at the end of the period: the denominator of every store count.
  const asOf = Math.min(end - 1, now);
  const active = new Map<Id<"outlets">, Doc<"outlets">>();
  for (const outletId of byOutlet.keys()) {
    if (!inTerritoryAt(outletId, asOf)) continue;
    const outlet = await ctx.db.get(outletId);
    if (outlet && outlet.status === "active") active.set(outletId, outlet);
  }

  const products = new Map<string, Product | null>();
  const productByCode = async (code: string) => {
    if (!products.has(code)) {
      const row = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      products.set(
        code,
        row ? { code, name: row.name, category: row.category } : null,
      );
    }
    return products.get(code) ?? null;
  };

  // Sales: orders of each linked customer, in the territory at the moment of sale.
  const figures = new Map<string, SkuFigures>();
  const skuFigures = (code: string) => {
    let row = figures.get(code);
    if (!row) {
      row = emptySkuFigures();
      figures.set(code, row);
    }
    return row;
  };
  const buyers = new Map<string, Set<Id<"outlets">>>();
  const ordersByCode = new Map<string, Doc<"orders">[]>();
  const counted = new Set<Id<"orders">>();
  let linesRead = 0;
  for (const outletId of byOutlet.keys()) {
    const links = (
      await ctx.db
        .query("outletCustomerLinks")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", outletId).lt("effectiveFrom", end),
        )
        .order("desc")
        .take(MAX_HISTORY)
    ).filter(
      (link) =>
        (link.effectiveTo === undefined || link.effectiveTo > start) &&
        link.effectiveTo !== link.effectiveFrom,
    );
    for (const link of links) {
      const customer = await ctx.db.get(link.customerId);
      if (!customer) continue;
      let list = ordersByCode.get(customer.code);
      if (!list) {
        list = await ctx.db
          .query("orders")
          .withIndex("by_customer", (q) =>
            q
              .eq("customerCode", customer.code)
              .gte("_creationTime", start - DAY),
          )
          .take(MAX_CUSTOMER_ORDERS + 1);
        if (list.length > MAX_CUSTOMER_ORDERS)
          throw new ConvexError(
            "Too many orders for one customer since this period; pick a more recent period",
          );
        ordersByCode.set(customer.code, list);
      }
      for (const order of list) {
        if (order.createdAt >= end + LATE_ORDER_WINDOW_MS) continue;
        const instant = saleInstant(order);
        if (
          instant < start ||
          instant >= end ||
          !activeAt(link.effectiveFrom, link.effectiveTo, instant) ||
          !inTerritoryAt(outletId, instant)
        )
          continue;
        // A customer shared by two stores of the territory is counted once.
        if (counted.has(order._id)) continue;
        counted.add(order._id);
        if (!(await inScope(order))) continue;
        const lines = await ctx.db
          .query("orderLines")
          .withIndex("by_order", (q) => q.eq("orderId", order._id))
          .take(MAX_ORDER_LINES);
        linesRead += lines.length;
        if (linesRead > MAX_LINES_READ) throw new ConvexError(TOO_BIG);
        const result = orderFigures(order, lines, SUNPRIDE_ORGANIZATION_ID);
        if (!result) continue;
        for (const sku of result.skus) {
          const row = skuFigures(sku.productCode);
          row.orders += sku.orders;
          row.quantity += sku.quantity;
          row.salesMinor += sku.salesMinor;
          row.returnQuantity += sku.returnQuantity;
          row.returnsMinor += sku.returnsMinor;
          if (sku.orders > 0 && active.has(outletId)) {
            const set = buyers.get(sku.productCode) ?? new Set();
            set.add(outletId);
            buyers.set(sku.productCode, set);
          }
        }
      }
    }
  }
  for (const [code, set] of buyers) skuFigures(code).buyingOutlets = set.size;

  // Availability: each active store's latest audit of the period.
  const productIds = new Map<Id<"products">, Doc<"products"> | null>();
  const shelf = new Map<Id<"outlets">, Map<string, ShelfStatus>>();
  for (const outletId of active.keys()) {
    const audit = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_outletId_and_serviceDate", (q) =>
        q
          .eq("outletId", outletId)
          .gte("serviceDate", from)
          .lte("serviceDate", to),
      )
      .order("desc")
      .first();
    if (!audit || audit.organizationId !== SUNPRIDE_ORGANIZATION_ID) continue;
    const lines = await ctx.db
      .query("merchandisingAvailability")
      .withIndex("by_auditId", (q) => q.eq("auditId", audit._id))
      .take(MAX_AVAILABILITY_LINES);
    const statuses = new Map<string, ShelfStatus>();
    for (const line of lines) {
      if (!productIds.has(line.productId))
        productIds.set(line.productId, await ctx.db.get(line.productId));
      const product = productIds.get(line.productId);
      if (!product) continue;
      statuses.set(product.code, line.status);
      if (!products.has(product.code))
        products.set(product.code, {
          code: product.code,
          name: product.name,
          category: product.category,
        });
    }
    shelf.set(outletId, statuses);
    for (const [code, status] of statuses)
      addShelfStatus(skuFigures(code), status);
  }

  return { active, figures, buyers, shelf, productByCode };
}

/** One territory's SKU figures for a period of Manila dates (at most 31). */
export const territory = query({
  args: {
    territoryId: v.id("territories"),
    from: v.string(),
    to: v.string(),
  },
  returns: v.object({
    territoryId: v.id("territories"),
    code: v.string(),
    name: v.string(),
    channel: v.union(v.string(), v.null()),
    from: v.string(),
    to: v.string(),
    sourceRef: v.string(),
    activeOutlets: v.number(),
    /** Active stores with at least one merchandising audit in the period. */
    auditedOutlets: v.number(),
    truncated: v.boolean(),
    skus: v.array(
      v.object({
        productCode: v.string(),
        name: v.union(v.string(), v.null()),
        category: v.union(v.string(), v.null()),
        figures: skuFiguresValidator,
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { territory, sc } = await loadTerritory(
      ctx,
      args.territoryId,
      args.from,
      args.to,
    );
    const data = await territoryData(ctx, sc, territory, args.from, args.to);
    const codes = [...data.figures.keys()].sort();
    const skus = [];
    for (const code of codes.slice(0, MAX_SKUS)) {
      const product = await data.productByCode(code);
      skus.push({
        productCode: code,
        name: product?.name ?? null,
        category: product?.category ?? null,
        figures: data.figures.get(code)!,
      });
    }
    return {
      territoryId: territory._id,
      code: territory.code,
      name: territory.name,
      channel: territory.channel ?? null,
      from: args.from,
      to: args.to,
      sourceRef: SKU_SOURCE,
      activeOutlets: data.active.size,
      auditedOutlets: data.shelf.size,
      truncated: codes.length > MAX_SKUS,
      skus,
    };
  },
});

/**
 * One SKU's distribution gaps in one territory: active stores that did not buy it in the
 * period, with the latest audited shelf status (out of stock first).
 */
export const gaps = query({
  args: {
    territoryId: v.id("territories"),
    from: v.string(),
    to: v.string(),
    productCode: v.string(),
  },
  returns: v.object({
    territoryId: v.id("territories"),
    productCode: v.string(),
    gapCount: v.number(),
    outlets: v.array(
      v.object({
        outletId: v.id("outlets"),
        code: v.string(),
        name: v.string(),
        shelfStatus: v.union(shelfStatus, v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const productCode = args.productCode.trim();
    if (!productCode || productCode.length > 80)
      throw new ConvexError("invalid_request");
    const { territory, sc } = await loadTerritory(
      ctx,
      args.territoryId,
      args.from,
      args.to,
    );
    const data = await territoryData(ctx, sc, territory, args.from, args.to);
    const buying = data.buyers.get(productCode) ?? new Set();
    const rows = [];
    for (const [outletId, outlet] of data.active) {
      if (buying.has(outletId)) continue;
      rows.push({
        outletId,
        code: outlet.code,
        name: outlet.name,
        shelfStatus: data.shelf.get(outletId)?.get(productCode) ?? null,
      });
    }
    return {
      territoryId: territory._id,
      productCode,
      gapCount: rows.length,
      outlets: sortGapOutlets(rows).slice(0, MAX_GAP_OUTLETS),
    };
  },
});
