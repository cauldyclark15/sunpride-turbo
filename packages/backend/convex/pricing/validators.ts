import { v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * SP-0129 / ADR-008: governed promotion rules on the SP-0088 price lists (pricing/model.ts).
 * Units are unit-of-measure codes, as on `priceListLines.uom`; money is whole centavos
 * (JSON-safe numbers). Anything a client cannot evaluate fails closed.
 */

/** A whole quantity of one product in one unit (promotion thresholds and free goods). */
export const promotionUnitValidator = v.object({
  productId: v.id("products"),
  uom: v.string(),
  quantity: v.number(),
});

export const promotionRuleValidator = v.union(
  // Buy `buy.quantity` of a product, get `free.quantity` free (per full multiple).
  v.object({
    kind: v.literal("buy_x_get_y"),
    buy: promotionUnitValidator,
    free: promotionUnitValidator,
  }),
  // `percentOffBasisPoints` (500 = 5%) off each line of `item.uom` once at least
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
    bundlePriceMinor: v.number(),
  }),
);
export type PromotionRule = Infer<typeof promotionRuleValidator>;
