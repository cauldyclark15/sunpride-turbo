import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { activeAt } from "../org/validation";
import {
  MAX_LINES_PER_PRODUCT,
  pricingCache,
  priceListFor,
  productPrices,
} from "./model";
import { promotionsAt } from "./promotions";

type Ctx = QueryCtx | MutationCtx;

/**
 * Van trucks sell at the Route Sales / PMOT list (call of 2 Oct 2026: PMOT, PMOT Extruck and
 * RDS are the same route-selling job), else the default list, resolved exactly as a field
 * outlet of that channel would be (SP-0088 `priceListFor`). Per-customer van pricing is
 * SP-0105's scope.
 */
export const VAN_PRICE_CHANNEL = "Route Sales";

/** Effective window of the line(s) giving `price` for `uom` at `at` (all agree on the value). */
async function lineWindow(
  ctx: Ctx,
  listId: Id<"priceLists">,
  productId: Id<"products">,
  uom: string,
  price: number,
  at: number,
) {
  const rows = await ctx.db
    .query("priceListLines")
    .withIndex("by_priceListId_and_productId", (q) =>
      q.eq("priceListId", listId).eq("productId", productId),
    )
    .take(MAX_LINES_PER_PRODUCT + 1);
  const live = rows.filter(
    (row) =>
      row.uom === uom &&
      row.unitPriceMinor === price &&
      activeAt(row.effectiveFrom, row.effectiveTo, at),
  );
  if (live.length === 0) return null;
  const ends = live.flatMap((row) =>
    row.effectiveTo === undefined ? [] : [row.effectiveTo],
  );
  return {
    effectiveFrom: Math.max(...live.map((row) => row.effectiveFrom)),
    effectiveTo: ends.length > 0 ? Math.min(...ends) : null,
  };
}

/** Promotion units travel as unit codes (`uomCode`), money as decimal strings (van-v1). */
function wirePromotion(promotion: Doc<"promotions">) {
  const unit = (u: {
    productId: Id<"products">;
    uom: string;
    quantity: number;
  }) => ({ productId: u.productId, uomCode: u.uom, quantity: u.quantity });
  const rule = promotion.rule;
  return {
    promotionId: promotion._id,
    code: promotion.code,
    name: promotion.name,
    priceListId: promotion.priceListId ?? null,
    effectiveFrom: promotion.effectiveFrom,
    effectiveTo: promotion.effectiveTo ?? null,
    rule:
      rule.kind === "buy_x_get_y"
        ? { kind: rule.kind, buy: unit(rule.buy), free: unit(rule.free) }
        : rule.kind === "percent_off"
          ? {
              kind: rule.kind,
              item: unit(rule.item),
              percentOffBasisPoints: rule.percentOffBasisPoints,
            }
          : {
              kind: rule.kind,
              components: rule.components.map(unit),
              bundlePriceMinor: String(rule.bundlePriceMinor),
            },
  };
}

/**
 * VAN bootstrap pricing: the Route Sales line of each truck product in the van's selling unit
 * (only where SP-0088 resolves exactly one effective price), plus that list's promotions whose
 * products are all on the truck. Integers travel as decimal strings (van-v1). A promotion
 * read that overflows ships no promotions (fail closed).
 */
export async function vanPricing(
  ctx: Ctx,
  products: { productId: Id<"products">; uomCode: string }[],
  at: number,
) {
  const cache = pricingCache();
  const list = await priceListFor(
    ctx,
    { channel: VAN_PRICE_CHANNEL },
    null,
    at,
    cache,
  );
  if (!list) return { priceLines: [], promotions: [] };
  const priceLines = [];
  for (const product of products) {
    const price = (
      await productPrices(ctx, list._id, product.productId, at, cache)
    ).get(product.uomCode);
    if (price === undefined) continue;
    const window = await lineWindow(
      ctx,
      list._id,
      product.productId,
      product.uomCode,
      price,
      at,
    );
    if (!window) continue;
    priceLines.push({
      priceListId: list._id,
      priceListCode: list.code,
      productId: product.productId,
      uomCode: product.uomCode,
      unitPriceMinor: String(price),
      currency: list.currency,
      ...window,
    });
  }
  const onTruck = new Set<string>(products.map((p) => p.productId));
  const { promotions } = await promotionsAt(ctx, list._id, at);
  return {
    priceLines,
    promotions: promotions
      .filter((promotion) => {
        const rule = promotion.rule;
        const units =
          rule.kind === "buy_x_get_y"
            ? [rule.buy, rule.free]
            : rule.kind === "percent_off"
              ? [rule.item]
              : rule.components;
        return units.every((u) => onTruck.has(u.productId));
      })
      .map(wirePromotion),
  };
}
