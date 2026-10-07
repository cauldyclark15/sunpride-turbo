import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * Field order submission (SP-0060, AND-015).
 *
 * A salesperson's order travels as the visit's `order_intent` activity with its lines, so
 * the call is productive (purchase order) and the order shares the visit's idempotent,
 * ordered mobile outbox. Lines carry a product, one of its order units and a whole quantity,
 * never a price: the server prices them from the governed price list (pricing/model.ts,
 * SP-0088) and records the result with a credit check in `fieldOrderPricings`. The client
 * said key accounts enter the PO in the app now; a later phase turns it straight into the
 * sales order (call of 2 Oct 2026, Q18).
 */
export const MAX_FIELD_ORDER_LINES = 100;
export const MAX_FIELD_ORDER_QUANTITY = 99_999;
export const MAX_FIELD_ORDER_UOM = 20;

export const fieldOrderLineValidator = v.object({
  productId: v.id("products"),
  uom: v.string(),
  quantity: v.number(),
});
export type FieldOrderLine = Infer<typeof fieldOrderLineValidator>;

/** Shape-only checks (no database). Throws `invalid_request`. */
export function validateFieldOrderLines(lines: FieldOrderLine[]) {
  if (lines.length < 1 || lines.length > MAX_FIELD_ORDER_LINES)
    throw new ConvexError("invalid_request");
  if (new Set(lines.map((line) => line.productId)).size !== lines.length)
    throw new ConvexError("invalid_request");
  for (const line of lines)
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > MAX_FIELD_ORDER_QUANTITY ||
      line.uom.trim() !== line.uom ||
      line.uom.length < 1 ||
      line.uom.length > MAX_FIELD_ORDER_UOM
    )
      throw new ConvexError("invalid_request");
}
