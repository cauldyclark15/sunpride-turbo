import { v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * SP-0129 / ADR-008: the governed price baseline until SAP pricing is integrated.
 *
 * A price list is chosen by the outlet's channel (Key Accounts, Route Sales / PMOT, Public
 * Market). Lines are effective-dated prices per product and unit of measure in minor currency
 * units (centavos, VAT-inclusive). Promotions are governed rule sets of three kinds; anything
 * a client cannot evaluate fails closed. `source` marks where a row came from so the beta
 * sample can be swapped for real data without touching code (`beta/sample:reset`).
 */
export const pricingSourceValidator = v.union(
  v.literal("beta_sample"),
  v.literal("office"),
  v.literal("sap"),
);
export type PricingSource = Infer<typeof pricingSourceValidator>;

export const priceListStatusValidator = v.union(
  v.literal("active"),
  v.literal("inactive"),
);

/** A whole quantity of one product in one unit (promotion thresholds and free goods). */
export const promotionUnitValidator = v.object({
  productId: v.id("products"),
  uomId: v.id("unitsOfMeasure"),
  quantity: v.number(),
});

export const promotionRuleValidator = v.union(
  // Buy `buy.quantity` of a product, get `free.quantity` free (per full multiple).
  v.object({
    kind: v.literal("buy_x_get_y"),
    buy: promotionUnitValidator,
    free: promotionUnitValidator,
  }),
  // `percentOffBasisPoints` (500 = 5%) off each line of `item.uomId` once at least
  // `item.quantity` of that unit is ordered.
  v.object({
    kind: v.literal("percent_off"),
    item: promotionUnitValidator,
    percentOffBasisPoints: v.number(),
  }),
  // Every component together sells for `bundlePriceMinor` (per complete bundle).
  v.object({
    kind: v.literal("bundle"),
    components: v.array(promotionUnitValidator),
    bundlePriceMinor: v.int64(),
  }),
);
export type PromotionRule = Infer<typeof promotionRuleValidator>;
