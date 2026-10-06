import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  activePriceLists,
  applyPromotions,
  effectiveLines,
  priceLineAt,
  priceListForChannel,
  priceListForOutlet,
  promotionsAt,
} from "./model";
import type { PromotionRule } from "./validators";

type Ctx = QueryCtx | MutationCtx;

/**
 * Van trucks sell at the Route Sales / PMOT list (call of 2 Oct 2026: PMOT, PMOT Extruck and
 * RDS are the same route-selling job). Per-customer van pricing is SP-0105's scope.
 */
export const VAN_PRICE_CHANNEL = "ROUTE_SALES";

type UomCache = Map<Id<"unitsOfMeasure">, Doc<"unitsOfMeasure"> | null>;
async function uomOf(ctx: Ctx, cache: UomCache, id: Id<"unitsOfMeasure">) {
  if (!cache.has(id)) cache.set(id, await ctx.db.get(id));
  return cache.get(id) ?? null;
}

async function wireRule(ctx: Ctx, cache: UomCache, rule: PromotionRule) {
  const unit = async (u: {
    productId: Id<"products">;
    uomId: Id<"unitsOfMeasure">;
    quantity: number;
  }) => {
    const uom = await uomOf(ctx, cache, u.uomId);
    return uom?.active
      ? { productId: u.productId, uomCode: uom.code, quantity: u.quantity }
      : null;
  };
  if (rule.kind === "buy_x_get_y") {
    const [buy, free] = [await unit(rule.buy), await unit(rule.free)];
    return buy && free ? { kind: rule.kind, buy, free } : null;
  }
  if (rule.kind === "percent_off") {
    const item = await unit(rule.item);
    return item
      ? {
          kind: rule.kind,
          item,
          percentOffBasisPoints: rule.percentOffBasisPoints,
        }
      : null;
  }
  const components = [];
  for (const component of rule.components) {
    const wired = await unit(component);
    if (!wired) return null;
    components.push(wired);
  }
  return {
    kind: rule.kind,
    components,
    bundlePriceMinor: rule.bundlePriceMinor,
  };
}

/** Promotions in wire form; a rule with an unknown/retired unit is withheld (fail closed). */
async function wirePromotions(
  ctx: Ctx,
  cache: UomCache,
  priceListId: Id<"priceLists"> | null,
  at: number,
) {
  const out = [];
  for (const promotion of await promotionsAt(ctx, priceListId, at)) {
    const rule = await wireRule(ctx, cache, promotion.rule);
    if (!rule) continue;
    out.push({
      promotionId: promotion._id,
      code: promotion.code,
      name: promotion.name,
      priceListId: promotion.priceListId ?? null,
      effectiveFrom: promotion.effectiveFrom,
      effectiveTo: promotion.effectiveTo ?? null,
      rule,
    });
  }
  return out;
}

/**
 * VAN bootstrap pricing: one Route Sales line per product in the van's selling unit, plus
 * that list's promotions. Integers that could exceed 2^53 travel as decimal strings.
 */
export async function vanPricing(
  ctx: Ctx,
  products: { productId: Id<"products">; uomCode: string }[],
  at: number,
) {
  const list = await priceListForChannel(ctx, VAN_PRICE_CHANNEL);
  if (!list) return { priceLines: [], promotions: [] };
  const cache: UomCache = new Map();
  const priceLines = [];
  for (const product of products) {
    const uom = await ctx.db
      .query("unitsOfMeasure")
      .withIndex("by_organizationId_and_code", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("code", product.uomCode),
      )
      .unique();
    if (!uom?.active) continue;
    const line = await priceLineAt(
      ctx,
      list._id,
      product.productId,
      uom._id,
      at,
    );
    if (!line) continue;
    priceLines.push({
      priceListId: list._id,
      priceListCode: list.code,
      productId: product.productId,
      uomCode: uom.code,
      unitPriceMinor: line.unitPriceMinor.toString(),
      currency: list.currency,
      effectiveFrom: line.effectiveFrom,
      effectiveTo: line.effectiveTo ?? null,
    });
  }
  const promotions = (await wirePromotions(ctx, cache, list._id, at)).map(
    (promotion) => ({
      ...promotion,
      rule:
        promotion.rule.kind === "bundle"
          ? {
              ...promotion.rule,
              bundlePriceMinor: promotion.rule.bundlePriceMinor.toString(),
            }
          : promotion.rule,
    }),
  );
  return { priceLines, promotions };
}

/**
 * Mobile (field) bootstrap pricing for the outlets on a page: each outlet's channel list
 * with every effective line (all units), and the promotions in force. Minor units are JSON
 * numbers here (always far below 2^53 for peso prices).
 */
export async function mobilePricing(
  ctx: Ctx,
  outlets: Pick<Doc<"outlets">, "_id" | "channel">[],
  at: number,
) {
  const lists = await activePriceLists(ctx);
  const cache: UomCache = new Map();
  const outletPriceLists = [];
  const used = new Map<Id<"priceLists">, Doc<"priceLists">>();
  for (const outlet of outlets) {
    const list = await priceListForOutlet(ctx, outlet, lists);
    if (!list) continue;
    used.set(list._id, list);
    outletPriceLists.push({ outletId: outlet._id, priceListId: list._id });
  }
  const priceLists = [];
  const wired: Awaited<ReturnType<typeof wirePromotions>> = [];
  for (const list of used.values()) {
    const lines = [];
    for (const line of await effectiveLines(ctx, list._id, at)) {
      const uom = await uomOf(ctx, cache, line.uomId);
      if (!uom?.active) continue;
      lines.push({
        productId: line.productId,
        uomCode: uom.code,
        unitPriceMinor: Number(line.unitPriceMinor),
        effectiveFrom: line.effectiveFrom,
        effectiveTo: line.effectiveTo ?? null,
      });
    }
    priceLists.push({
      priceListId: list._id,
      code: list.code,
      name: list.name,
      channel: list.channel,
      currency: list.currency,
      vatInclusive: list.vatInclusive,
      lines,
    });
    for (const promotion of await wirePromotions(ctx, cache, list._id, at))
      if (!wired.some((p) => p.promotionId === promotion.promotionId))
        wired.push(promotion);
  }
  const promotions = wired.map((promotion) => ({
    ...promotion,
    rule:
      promotion.rule.kind === "bundle"
        ? {
            ...promotion.rule,
            bundlePriceMinor: Number(promotion.rule.bundlePriceMinor),
          }
        : promotion.rule,
  }));
  return { priceLists, outletPriceLists, promotions };
}

/**
 * ADR-008: price a received field order server-side at receipt and keep the result next to
 * the order intent. Lines without exactly one effective price leave the order
 * `needs_office_price` (the office prices it); the phone never supplies a price.
 */
export async function recordFieldOrderPrice(
  ctx: MutationCtx,
  args: {
    activityId: Id<"visitActivities">;
    visit: Pick<Doc<"visitExecutions">, "_id" | "outletId" | "orgUnitId">;
    clientOrderId: string;
    lines: { productId: Id<"products">; uom: string; quantity: number }[];
    at: number;
  },
) {
  const outlet = await ctx.db.get(args.visit.outletId);
  const list = outlet ? await priceListForOutlet(ctx, outlet) : null;
  const inputs = [];
  for (const line of args.lines) {
    const uom = await ctx.db
      .query("unitsOfMeasure")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", line.uom),
      )
      .unique();
    const price =
      list && uom?.active
        ? await priceLineAt(ctx, list._id, line.productId, uom._id, args.at)
        : null;
    inputs.push({
      line,
      uomId: uom?._id ?? null,
      unitPriceMinor: price?.unitPriceMinor ?? null,
    });
  }
  const evaluable = inputs.flatMap((input) =>
    input.uomId
      ? [
          {
            productId: input.line.productId,
            uomId: input.uomId,
            quantity: input.line.quantity,
            unitPriceMinor: input.unitPriceMinor,
          },
        ]
      : [],
  );
  const result = applyPromotions(
    evaluable,
    list ? await promotionsAt(ctx, list._id, args.at) : [],
  );
  const lines = inputs.map((input) => {
    const priced = input.uomId
      ? result.lines.find(
          (row) =>
            row.productId === input.line.productId && row.uomId === input.uomId,
        )
      : undefined;
    return {
      productId: input.line.productId,
      uom: input.line.uom,
      quantity: input.line.quantity,
      ...(priced?.unitPriceMinor != null
        ? { unitPriceMinor: priced.unitPriceMinor }
        : {}),
      ...(priced?.grossMinor != null ? { grossMinor: priced.grossMinor } : {}),
      discountMinor: priced?.discountMinor ?? 0n,
      freeQuantity: priced?.freeQuantity ?? 0,
    };
  });
  const allPriced =
    list !== null &&
    inputs.every((input) => input.unitPriceMinor !== null) &&
    result.priced;
  return ctx.db.insert("fieldOrderPrices", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    orgUnitId: args.visit.orgUnitId,
    activityId: args.activityId,
    visitId: args.visit._id,
    outletId: args.visit.outletId,
    clientOrderId: args.clientOrderId,
    ...(list ? { priceListId: list._id } : {}),
    currency: list?.currency ?? "PHP",
    status: allPriced ? "priced" : "needs_office_price",
    lines,
    promotionCodes: result.applied,
    grossMinor: result.grossMinor,
    discountMinor: result.discountMinor,
    totalMinor: result.totalMinor,
    pricedAt: args.at,
  });
}
