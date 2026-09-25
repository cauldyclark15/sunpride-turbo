import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { requireLocationCapability } from "./location_scope";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import { hashPayload, postMovement } from "./posting";
import { stockStatusValidator } from "./validators";

export const changeStatus = mutation({
  args: {
    idempotencyKey: v.string(),
    lotId: v.id("inventoryLots"),
    locationId: v.id("inventoryLocations"),
    fromStatus: stockStatusValidator,
    toStatus: stockStatusValidator,
    quantityBase: v.int64(),
    reasonCode: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    // Releasing held stock requires approval; moving stock into a hold is a write.
    const { identity } = await requireLocationCapability(
      ctx,
      args.toStatus === "available" ? "inventory.approve" : "inventory.write",
      args.locationId,
    );
    const lot = await ctx.db.get(args.lotId);
    if (!lot) throw new ConvexError("Lot not found");
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash: hashPayload(args),
      commandType: "quality.changeStatus",
      movementType: "status_change",
      sourceType: "quality_control",
      sourceDocumentId: lot._id,
      actorSubject: identity.tokenIdentifier,
      reasonCode: args.reasonCode,
      note: args.note,
      lines: [
        {
          productId: lot.productId,
          quantityBase: args.quantityBase,
          fromLocationId: args.locationId,
          toLocationId: args.locationId,
          fromStockStatus: args.fromStatus,
          toStockStatus: args.toStatus,
          allocations: [
            {
              lotId: lot._id,
              quantityBase: args.quantityBase,
              userSelected: true,
            },
          ],
          reasonCode: args.reasonCode,
        },
      ],
    });
    if (args.toStatus === "available")
      await ctx.db.patch(lot._id, {
        qualityStatus: "released",
        updatedAt: Date.now(),
      });
    else if (args.toStatus === "expired")
      await ctx.db.patch(lot._id, {
        qualityStatus: "expired",
        updatedAt: Date.now(),
      });
    else if (args.toStatus === "rejected")
      await ctx.db.patch(lot._id, {
        qualityStatus: "rejected",
        updatedAt: Date.now(),
      });
    else if (args.toStatus === "quarantine" || args.toStatus === "quality_hold")
      await ctx.db.patch(lot._id, {
        qualityStatus: "quarantined",
        updatedAt: Date.now(),
      });
    return movement.movementId;
  },
});

export const expireDueLots = internalMutation({
  args: { now: v.number(), cursor: v.optional(v.string()) },
  returns: v.object({
    processed: v.number(),
    continuationScheduled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const cutoff = args.now || Date.now();
    const lots = await ctx.db
      .query("inventoryLots")
      .withIndex("by_organizationId_and_qualityStatus_and_expiresAt", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("qualityStatus", "released")
          .lte("expiresAt", cutoff),
      )
      .take(20);
    let processed = 0;
    for (const lot of lots) {
      const balances = await ctx.db
        .query("inventoryLotBalances")
        .withIndex("by_organizationId_and_lotId", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("lotId", lot._id),
        )
        .take(25);
      for (const balance of balances) {
        if (balance.stockStatus !== "available" || balance.physicalBase <= 0n)
          continue;
        await postMovement(ctx, {
          idempotencyKey: `expire:${lot._id}:${balance.locationId}`,
          payloadHash: hashPayload({
            lotId: lot._id,
            locationId: balance.locationId,
            quantity: balance.physicalBase,
          }),
          commandType: "quality.expireLot",
          movementType: "status_change",
          sourceType: "expiry_job",
          sourceDocumentId: lot._id,
          actorSubject: "system:expiry",
          reasonCode: "lot_expired",
          lines: [
            {
              productId: lot.productId,
              quantityBase: balance.physicalBase,
              fromLocationId: balance.locationId,
              toLocationId: balance.locationId,
              fromStockStatus: "available",
              toStockStatus: "expired",
              allocations: [
                {
                  lotId: lot._id,
                  quantityBase: balance.physicalBase,
                  userSelected: true,
                },
              ],
            },
          ],
        });
        processed += 1;
      }
      await ctx.db.patch(lot._id, {
        qualityStatus: "expired",
        updatedAt: cutoff,
      });
    }
    return { processed, continuationScheduled: false };
  },
});
