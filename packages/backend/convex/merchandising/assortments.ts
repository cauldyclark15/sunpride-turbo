import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt, prospective } from "../org/validation";
import { requireOutletCapability } from "../outlets/validation";
import { boundedText } from "../visits/validation";
import { MAX_ASSORTMENT_PRODUCTS } from "./validators";

/** Blueprint §16: the outlet's required assortment in effect at `at`, or null. */
export async function assortmentAt(
  ctx: QueryCtx | MutationCtx,
  outletId: Id<"outlets">,
  at: number,
): Promise<Doc<"outletAssortments"> | null> {
  const latest = await ctx.db
    .query("outletAssortments")
    .withIndex("by_outletId_and_effectiveFrom", (q) =>
      q.eq("outletId", outletId).lte("effectiveFrom", at),
    )
    .order("desc")
    .first();
  return latest && activeAt(latest.effectiveFrom, latest.effectiveTo, at)
    ? latest
    : null;
}

/** A product a merchandising row may reference: active and Sunpride's. */
export function usableProduct(product: Doc<"products"> | null) {
  return Boolean(
    product?.active &&
    (!product.organizationId ||
      product.organizationId === SUNPRIDE_ORGANIZATION_ID),
  );
}

/**
 * Schedules a new required-assortment version for one outlet. Prospective only; a version
 * already scheduled at or after `effectiveFrom` is never overwritten. An empty list ends the
 * outlet's required assortment from that instant.
 */
export const set = mutation({
  args: {
    outletId: v.id("outlets"),
    productIds: v.array(v.id("products")),
    effectiveFrom: v.number(),
    sourceRef: v.string(),
  },
  returns: v.id("outletAssortments"),
  handler: async (ctx, args) => {
    const { identity } = await requireOutletCapability(
      ctx,
      "outlet.manage",
      args.outletId,
    );
    prospective(args.effectiveFrom);
    const sourceRef = boundedText(args.sourceRef);
    if (
      args.productIds.length > MAX_ASSORTMENT_PRODUCTS ||
      new Set(args.productIds).size !== args.productIds.length
    )
      throw new ConvexError("invalid_request");
    for (const productId of args.productIds)
      if (!usableProduct(await ctx.db.get(productId)))
        throw new ConvexError("invalid_request");
    const scheduled = await ctx.db
      .query("outletAssortments")
      .withIndex("by_outletId_and_effectiveFrom", (q) =>
        q
          .eq("outletId", args.outletId)
          .gte("effectiveFrom", args.effectiveFrom),
      )
      .first();
    if (scheduled) throw new ConvexError("conflict");
    const replaced = await assortmentAt(ctx, args.outletId, args.effectiveFrom);
    if (replaced)
      await ctx.db.patch(replaced._id, { effectiveTo: args.effectiveFrom });
    return await ctx.db.insert("outletAssortments", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      outletId: args.outletId,
      productIds: args.productIds,
      effectiveFrom: args.effectiveFrom,
      sourceRef,
      actorSubject: identity.tokenIdentifier,
      createdAt: Date.now(),
    });
  },
});

export const current = query({
  args: { outletId: v.id("outlets"), asOf: v.optional(v.number()) },
  returns: v.union(
    v.null(),
    v.object({
      assortmentId: v.id("outletAssortments"),
      productIds: v.array(v.id("products")),
      effectiveFrom: v.number(),
      effectiveTo: v.union(v.number(), v.null()),
      sourceRef: v.string(),
    }),
  ),
  handler: async (ctx, { outletId, asOf }) => {
    await requireOutletCapability(ctx, "outlet.read", outletId);
    if (asOf !== undefined && !Number.isSafeInteger(asOf))
      throw new ConvexError("invalid_request");
    const row = await assortmentAt(ctx, outletId, asOf ?? Date.now());
    return row
      ? {
          assortmentId: row._id,
          productIds: row.productIds,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo ?? null,
          sourceRef: row.sourceRef,
        }
      : null;
  },
});
