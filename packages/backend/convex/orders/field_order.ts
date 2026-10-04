import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { accountFor, usableProduct } from "../callSheets/model";
import {
  type FieldOrderLine,
  validateFieldOrderLines,
} from "./field_order_validators";

/**
 * The outlet must have an office-maintained account setup (the phone's only order catalog),
 * each product must still be usable and the quantity must be in the product's current unit.
 * Like the call sheet, a product removed from the setup during the day does not strand a
 * queued order, but a changed unit does: quantities in the wrong unit are never recorded.
 */
export async function validateFieldOrder(
  ctx: MutationCtx,
  visitId: Id<"visitExecutions">,
  outletId: Id<"outlets">,
  clientOrderId: string,
  lines: FieldOrderLine[],
) {
  validateFieldOrderLines(lines);
  if (!(await accountFor(ctx, outletId)))
    throw new ConvexError("invalid_request");
  for (const line of lines) {
    const product = await ctx.db.get(line.productId);
    if (!usableProduct(product) || product.uom !== line.uom)
      throw new ConvexError("invalid_request");
  }
  // One submission per phone order: a second request with a new ID must not double it.
  const recorded = await ctx.db
    .query("visitActivities")
    .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visitId))
    .take(501);
  if (recorded.length > 500) throw new ConvexError("invalid_request");
  if (
    recorded.some(
      (row) =>
        row.activity.kind === "order_intent" &&
        row.activity.clientOrderId === clientOrderId,
    )
  )
    throw new ConvexError("conflict");
}
