import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { accountFor, usableProduct } from "../callSheets/model";
import { localDate } from "../coverage/validation";
import { orderUnits } from "../pricing/model";
import {
  type FieldOrderLine,
  validateFieldOrderLines,
} from "./field_order_validators";

/** Replaced revisions read per order; more office edits than this in one day fail closed. */
const MAX_DAY_REVISIONS = 50;
const DAY_MS = 86_400_000;

/**
 * Products the outlet's account setup (the phone's only order catalog) authorized at any
 * time on the visit's Manila service day [midnight, next midnight): every revision whose
 * effective interval overlaps that day, including the current revision when it began
 * before the day ended. A product the office removed during the day (or on a later day)
 * stays orderable for a queued offline order; a product added only on a later day, or
 * that no revision effective that day ever listed, is refused. A replaced revision
 * claiming to outlast the current one is inconsistent and authorizes nothing.
 */
async function authorizedProducts(
  ctx: MutationCtx,
  account: Doc<"callSheetAccounts">,
  serviceDate: string,
) {
  const dayStart = localDate(serviceDate);
  const dayEnd = dayStart + DAY_MS;
  const allowed = new Set<Id<"products">>();
  if (account.updatedAt < dayEnd)
    for (const line of account.lines) allowed.add(line.productId);
  let read = 0;
  // Ascending by supersededAt: a revision's start is its predecessor's end, so once one
  // starts after the day every later one does too.
  for await (const row of ctx.db
    .query("callSheetAccountRevisions")
    .withIndex("by_outletId_and_supersededAt", (q) =>
      q.eq("outletId", account.outletId).gt("supersededAt", dayStart),
    )) {
    if (row.effectiveFrom >= dayEnd) break;
    if (++read > MAX_DAY_REVISIONS) throw new ConvexError("invalid_request");
    if (
      row.organizationId !== account.organizationId ||
      row.revision >= account.revision ||
      row.supersededAt > account.updatedAt ||
      row.effectiveFrom > row.supersededAt
    )
      continue;
    for (const productId of row.productIds) allowed.add(productId);
  }
  return allowed;
}

/**
 * The outlet must have an office-maintained account setup, each product must have been
 * authorized by it on the service day (see `authorizedProducts`) and still be usable, and
 * the quantity must be in one of the product's current order units (its own unit or an active
 * selling unit, SP-0088): quantities in a retired unit are never recorded.
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
    if (
      !usableProduct(product) ||
      !(await orderUnits(ctx, product)).includes(line.uom)
    )
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
