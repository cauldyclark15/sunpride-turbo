import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { accountFor, usableProduct } from "../callSheets/model";
import { localDate } from "../coverage/validation";
import {
  type FieldOrderLine,
  validateFieldOrderLines,
} from "./field_order_validators";

/** Replaced revisions read per order; more office edits than this in one day fail closed. */
const MAX_DAY_REVISIONS = 50;

/**
 * Products the outlet's account setup (the phone's only order catalog) authorized at any
 * time on the visit's Manila service day: the current revision plus every revision replaced
 * since that day's midnight. A product the office removed during the day stays orderable
 * for a queued offline order; a product no revision that day ever listed is refused.
 */
async function authorizedProducts(
  ctx: MutationCtx,
  account: Doc<"callSheetAccounts">,
  serviceDate: string,
) {
  const allowed = new Set<Id<"products">>(
    account.lines.map((line) => line.productId),
  );
  const replaced = await ctx.db
    .query("callSheetAccountRevisions")
    .withIndex("by_outletId_and_supersededAt", (q) =>
      q
        .eq("outletId", account.outletId)
        .gte("supersededAt", localDate(serviceDate)),
    )
    .take(MAX_DAY_REVISIONS);
  for (const row of replaced)
    if (row.organizationId === account.organizationId)
      for (const productId of row.productIds) allowed.add(productId);
  return allowed;
}

/**
 * The outlet must have an office-maintained account setup, each product must have been
 * authorized by it on the service day (see `authorizedProducts`) and still be usable, and
 * the quantity must be in the product's current unit: quantities in a changed unit are
 * never recorded.
 */
export async function validateFieldOrder(
  ctx: MutationCtx,
  visit: Pick<Doc<"visitExecutions">, "_id" | "outletId" | "serviceDate">,
  clientOrderId: string,
  lines: FieldOrderLine[],
) {
  validateFieldOrderLines(lines);
  const account = await accountFor(ctx, visit.outletId);
  if (!account) throw new ConvexError("invalid_request");
  const allowed = await authorizedProducts(ctx, account, visit.serviceDate);
  for (const line of lines) {
    if (!allowed.has(line.productId)) throw new ConvexError("invalid_request");
    const product = await ctx.db.get(line.productId);
    if (!usableProduct(product) || product.uom !== line.uom)
      throw new ConvexError("invalid_request");
  }
  // One submission per phone order: a second request with a new ID must not double it.
  const recorded = await ctx.db
    .query("visitActivities")
    .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visit._id))
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
