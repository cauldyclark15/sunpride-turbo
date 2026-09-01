import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { requireIdentity, requireRole } from "../lib/auth";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  findExistingCommand,
  hashPayload,
  postMovement,
  reverseMovement,
  type PostingLine,
} from "./posting";
import { movementResultValidator, receiptStatusValidator } from "./validators";

const receiptLineInput = v.object({
  productId: v.id("products"),
  quantityBase: v.int64(),
  rejectedBase: v.optional(v.int64()),
  lotNumber: v.optional(v.string()),
  supplierLotNumber: v.optional(v.string()),
  manufacturedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  sourceLineId: v.optional(v.string()),
  unitCostMinor: v.optional(v.int64()),
});

export const reverse = mutation({
  args: {
    receiptId: v.id("goodsReceipts"),
    idempotencyKey: v.string(),
    reason: v.string(),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, ["admin", "manager"]);
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.status !== "posted" || !receipt.movementId)
      throw new ConvexError("Only a posted receipt can be reversed");
    const movement = await reverseMovement(ctx, {
      originalMovementId: receipt.movementId,
      idempotencyKey: args.idempotencyKey,
      actorSubject: identity.tokenIdentifier,
      sourceType: "goods_receipt_reversal",
      sourceDocumentId: receipt._id,
      note: args.reason,
    });
    await ctx.db.patch(receipt._id, {
      status: "cancelled",
      note: args.reason,
      updatedAt: Date.now(),
    });
    return movement.movementId;
  },
});

export const post = mutation({
  args: {
    idempotencyKey: v.string(),
    receiptType: v.union(
      v.literal("purchase_order"),
      v.literal("transfer"),
      v.literal("return"),
      v.literal("production"),
      v.literal("unplanned"),
    ),
    sourceDocumentId: v.optional(v.string()),
    receivingLocationId: v.id("inventoryLocations"),
    deliveryReference: v.optional(v.string()),
    note: v.optional(v.string()),
    lines: v.array(receiptLineInput),
  },
  returns: v.object({
    receiptId: v.id("goodsReceipts"),
    movement: movementResultValidator,
  }),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, ["admin", "manager"]);
    if (args.lines.length === 0)
      throw new ConvexError("Receipt needs at least one line");
    const payloadHash = hashPayload(args);
    const duplicate = await findExistingCommand(
      ctx,
      args.idempotencyKey,
      payloadHash,
    );
    if (duplicate?.sourceDocumentId) {
      const receiptId = ctx.db.normalizeId(
        "goodsReceipts",
        duplicate.sourceDocumentId,
      );
      if (receiptId && duplicate.movementId) {
        const movement = await ctx.db.get(duplicate.movementId);
        if (movement)
          return {
            receiptId,
            movement: {
              movementId: movement._id,
              movementNumber: movement.movementNumber,
              duplicate: true,
            },
          };
      }
    }
    const now = Date.now();
    const receiptId = await ctx.db.insert("goodsReceipts", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      receiptNumber: `GR-${now.toString(36).toUpperCase()}`,
      receiptType: args.receiptType,
      ...(args.sourceDocumentId
        ? { sourceDocumentId: args.sourceDocumentId }
        : {}),
      receivingLocationId: args.receivingLocationId,
      status: "in_inspection",
      ...(args.deliveryReference
        ? { deliveryReference: args.deliveryReference }
        : {}),
      receivedBy: identity.tokenIdentifier,
      ...(args.note ? { note: args.note } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const postingLines: PostingLine[] = [];
    for (const line of args.lines) {
      if (line.quantityBase <= 0n || (line.rejectedBase ?? 0n) < 0n)
        throw new ConvexError("Receipt quantities must be positive");
      const product = await ctx.db.get(line.productId);
      if (!product) throw new ConvexError("Receipt product not found");
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", line.productId),
        )
        .unique();
      let lotId: Id<"inventoryLots"> | null = null;
      if (policy?.trackingMode === "lot") {
        if (!line.lotNumber)
          throw new ConvexError(`${product.name} requires a lot number`);
        if (policy.expiryDateRequired && !line.expiresAt)
          throw new ConvexError(`${product.name} requires an expiry date`);
        if (policy.manufactureDateRequired && !line.manufacturedAt)
          throw new ConvexError(`${product.name} requires a manufacture date`);
        const normalizedLotNumber = line.lotNumber.trim().toUpperCase();
        const existingLot = await ctx.db
          .query("inventoryLots")
          .withIndex(
            "by_organizationId_and_productId_and_normalizedLotNumber",
            (q) =>
              q
                .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                .eq("productId", line.productId)
                .eq("normalizedLotNumber", normalizedLotNumber),
          )
          .unique();
        lotId =
          existingLot?._id ??
          (await ctx.db.insert("inventoryLots", {
            organizationId: SUNPRIDE_ORGANIZATION_ID,
            productId: line.productId,
            lotNumber: line.lotNumber.trim(),
            normalizedLotNumber,
            ...(line.supplierLotNumber
              ? { supplierLotNumber: line.supplierLotNumber }
              : {}),
            sourceType: args.receiptType,
            sourceDocumentId: receiptId,
            ...(line.sourceLineId ? { sourceLineId: line.sourceLineId } : {}),
            ...(line.manufacturedAt
              ? { manufacturedAt: line.manufacturedAt }
              : {}),
            receivedAt: now,
            ...(line.expiresAt ? { expiresAt: line.expiresAt } : {}),
            qualityStatus: policy.qualityReleaseRequired
              ? "pending"
              : "released",
            ...(line.unitCostMinor
              ? { unitCostMinor: line.unitCostMinor }
              : {}),
            createdAt: now,
            updatedAt: now,
          }));
      }
      const destinationStatus = policy?.qualityReleaseRequired
        ? "quality_hold"
        : "available";
      postingLines.push({
        productId: line.productId,
        quantityBase: line.quantityBase,
        toLocationId: args.receivingLocationId,
        toStockStatus: destinationStatus,
        allocations: lotId
          ? [{ lotId, quantityBase: line.quantityBase, userSelected: true }]
          : undefined,
        sourceLineId: line.sourceLineId,
        unitCostMinor: line.unitCostMinor,
        reasonCode: args.receiptType,
      });
      if ((line.rejectedBase ?? 0n) > 0n)
        postingLines.push({
          productId: line.productId,
          quantityBase: line.rejectedBase!,
          toLocationId: args.receivingLocationId,
          toStockStatus: "rejected",
          allocations: lotId
            ? [{ lotId, quantityBase: line.rejectedBase!, userSelected: true }]
            : undefined,
          sourceLineId: line.sourceLineId,
          unitCostMinor: line.unitCostMinor,
          reasonCode: "receipt_rejected",
        });
      await ctx.db.insert("goodsReceiptLines", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        receiptId,
        ...(line.sourceLineId ? { sourceLineId: line.sourceLineId } : {}),
        productId: line.productId,
        acceptedBase: line.quantityBase,
        rejectedBase: line.rejectedBase ?? 0n,
        ...(lotId ? { lotId } : {}),
        destinationStatus,
        ...(line.unitCostMinor ? { unitCostMinor: line.unitCostMinor } : {}),
        createdAt: now,
      });
    }
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash,
      commandType: "goodsReceipt.post",
      movementType: "goods_receipt",
      sourceType: args.receiptType,
      sourceDocumentId: receiptId,
      actorSubject: identity.tokenIdentifier,
      note: args.note,
      lines: postingLines,
    });
    await ctx.db.patch(receiptId, {
      status: "posted",
      movementId: movement.movementId,
      updatedAt: Date.now(),
    });
    return { receiptId, movement };
  },
});

export const list = query({
  args: {
    status: v.optional(receiptStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    if (args.status)
      return ctx.db
        .query("goodsReceipts")
        .withIndex("by_organizationId_and_status_and_createdAt", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("status", args.status!),
        )
        .order("desc")
        .take(Math.min(args.limit ?? 100, 250));
    return ctx.db
      .query("goodsReceipts")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 250));
  },
});
