import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import {
  readableLocationIds,
  requireLocationCapability,
} from "./location_scope";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  hashPayload,
  postMovement,
  reverseMovement,
  type PostingLine,
} from "./posting";
import { approvalStatusValidator, stockStatusValidator } from "./validators";

const lineInput = v.object({
  productId: v.id("products"),
  locationId: v.id("inventoryLocations"),
  lotId: v.optional(v.id("inventoryLots")),
  stockStatus: stockStatusValidator,
  varianceBase: v.int64(),
  unitCostMinor: v.optional(v.int64()),
});

type RequestInput = {
  adjustmentType: string;
  reasonCode: string;
  note?: string;
  lines: Array<{
    productId: import("../_generated/dataModel").Id<"products">;
    locationId: import("../_generated/dataModel").Id<"inventoryLocations">;
    lotId?: import("../_generated/dataModel").Id<"inventoryLots">;
    stockStatus: import("./validators").StockStatus;
    varianceBase: bigint;
    unitCostMinor?: bigint;
  }>;
};

/** Single request writer shared by manual and CSV submission. */
export async function requestAdjustment(ctx: MutationCtx, args: RequestInput) {
  const { identity } = await requireCapability(
    ctx,
    "inventory.adjustment.request",
  );
  if (args.lines.length === 0)
    throw new ConvexError("Adjustment needs at least one line");
  if (args.lines.length > 100)
    throw new ConvexError("Too many adjustment lines");
  for (const line of args.lines)
    await requireLocationCapability(
      ctx,
      "inventory.adjustment.request",
      line.locationId,
    );
  const now = Date.now();
  const adjustmentId = await ctx.db.insert("inventoryAdjustments", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    adjustmentNumber: `ADJ-${now.toString(36).toUpperCase()}`,
    adjustmentType: args.adjustmentType,
    reasonCode: args.reasonCode,
    status: "submitted",
    requestedBy: identity.tokenIdentifier,
    ...(args.note ? { note: args.note } : {}),
    createdAt: now,
    updatedAt: now,
  });
  for (const line of args.lines) {
    if (line.varianceBase === 0n)
      throw new ConvexError("Adjustment variance cannot be zero");
    const policy = await ctx.db
      .query("productInventoryPolicies")
      .withIndex("by_organizationId_and_productId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("productId", line.productId),
      )
      .unique();
    if (policy?.trackingMode === "lot" && !line.lotId)
      throw new ConvexError("Lot-tracked adjustments require a lot");
    await ctx.db.insert("inventoryAdjustmentLines", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      adjustmentId,
      ...line,
      reasonCode: args.reasonCode,
    });
  }
  await ctx.db.insert("auditLogs", {
    subject: identity.tokenIdentifier,
    action: "inventory.adjustment.requested",
    entityType: "inventoryAdjustment",
    entityId: adjustmentId,
    details: args.reasonCode,
    createdAt: now,
  });
  return adjustmentId;
}

export const request = mutation({
  args: {
    adjustmentType: v.string(),
    reasonCode: v.string(),
    note: v.optional(v.string()),
    lines: v.array(lineInput),
  },
  returns: v.id("inventoryAdjustments"),
  handler: requestAdjustment,
});

export const decide = mutation({
  args: {
    adjustmentId: v.id("inventoryAdjustments"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    idempotencyKey: v.optional(v.string()),
    comment: v.optional(v.string()),
  },
  returns: v.union(v.id("inventoryMovements"), v.null()),
  handler: async (ctx, args) => {
    const { identity } = await requireCapability(
      ctx,
      "inventory.adjustment.approve",
    );
    const adjustment = await ctx.db.get(args.adjustmentId);
    if (!adjustment || adjustment.status !== "submitted")
      throw new ConvexError("Adjustment is not awaiting a decision");
    if (adjustment.requestedBy === identity.tokenIdentifier)
      throw new ConvexError("Requester cannot approve their own adjustment");
    const lines = await ctx.db
      .query("inventoryAdjustmentLines")
      .withIndex("by_organizationId_and_adjustmentId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("adjustmentId", adjustment._id),
      )
      .take(101);
    if (lines.length === 0 || lines.length > 100)
      throw new ConvexError("Invalid adjustment line count");
    for (const line of lines)
      await requireLocationCapability(
        ctx,
        "inventory.adjustment.approve",
        line.locationId,
      );
    if (args.decision === "rejected") {
      await ctx.db.patch(adjustment._id, {
        status: "rejected",
        approvedBy: identity.tokenIdentifier,
        ...(args.comment ? { note: args.comment } : {}),
        updatedAt: Date.now(),
      });
      return null;
    }
    if (!args.idempotencyKey)
      throw new ConvexError("Approved adjustment needs an idempotency key");
    const postingLines: PostingLine[] = lines.map((line) => ({
      productId: line.productId,
      quantityBase:
        line.varianceBase < 0n ? -line.varianceBase : line.varianceBase,
      ...(line.varianceBase < 0n
        ? {
            fromLocationId: line.locationId,
            fromStockStatus: line.stockStatus,
          }
        : {
            toLocationId: line.locationId,
            toStockStatus: line.stockStatus,
          }),
      allocations: line.lotId
        ? [
            {
              lotId: line.lotId,
              quantityBase:
                line.varianceBase < 0n ? -line.varianceBase : line.varianceBase,
              userSelected: true,
            },
          ]
        : undefined,
      unitCostMinor: line.unitCostMinor,
      sourceLineId: line._id,
      reasonCode: line.reasonCode,
    }));
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash: hashPayload({ adjustmentId: adjustment._id, postingLines }),
      commandType: "inventoryAdjustment.approveAndPost",
      movementType: "inventory_adjustment",
      sourceType: "inventory_adjustment",
      sourceDocumentId: adjustment._id,
      actorSubject: identity.tokenIdentifier,
      reasonCode: adjustment.reasonCode,
      note: args.comment ?? adjustment.note,
      lines: postingLines,
    });
    await ctx.db.patch(adjustment._id, {
      status: "posted",
      approvedBy: identity.tokenIdentifier,
      movementId: movement.movementId,
      updatedAt: Date.now(),
    });
    return movement.movementId;
  },
});

export const reverse = mutation({
  args: {
    adjustmentId: v.id("inventoryAdjustments"),
    idempotencyKey: v.string(),
    reason: v.string(),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(
      ctx,
      "inventory.adjustment.approve",
    );
    if (
      profile.role !== "super_admin" &&
      profile.role !== "admin" &&
      profile.role !== "manager"
    )
      throw new ConvexError("Insufficient permission");
    const adjustment = await ctx.db.get(args.adjustmentId);
    if (!adjustment || adjustment.status !== "posted" || !adjustment.movementId)
      throw new ConvexError("Only a posted adjustment can be reversed");
    const lines = await ctx.db
      .query("inventoryAdjustmentLines")
      .withIndex("by_organizationId_and_adjustmentId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("adjustmentId", adjustment._id),
      )
      .take(101);
    if (lines.length === 0 || lines.length > 100)
      throw new ConvexError("Invalid adjustment line count");
    for (const line of lines)
      await requireLocationCapability(
        ctx,
        "inventory.adjustment.approve",
        line.locationId,
      );
    const movement = await reverseMovement(ctx, {
      originalMovementId: adjustment.movementId,
      idempotencyKey: args.idempotencyKey,
      actorSubject: identity.tokenIdentifier,
      sourceType: "inventory_adjustment_reversal",
      sourceDocumentId: adjustment._id,
      note: args.reason,
    });
    await ctx.db.patch(adjustment._id, {
      status: "reversed",
      note: args.reason,
      updatedAt: Date.now(),
    });
    return movement.movementId;
  },
});

export const list = query({
  args: {
    status: v.optional(approvalStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const canRead = await readableLocationIds(ctx);
    const rows = args.status
      ? await ctx.db
          .query("inventoryAdjustments")
          .withIndex("by_organizationId_and_status_and_createdAt", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("status", args.status!),
          )
          .order("desc")
          .take(250)
      : await ctx.db.query("inventoryAdjustments").order("desc").take(250);
    const visible = [];
    for (const row of rows) {
      const lines = await ctx.db
        .query("inventoryAdjustmentLines")
        .withIndex("by_organizationId_and_adjustmentId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("adjustmentId", row._id),
        )
        .take(101);
      if (lines.length > 100) continue;
      if (lines.length === 0 && row.sourceCountId) {
        const session = await ctx.db.get(row.sourceCountId);
        if (session && (await canRead(session.locationId))) visible.push(row);
      } else if (
        lines.length > 0 &&
        (
          await Promise.all(lines.map((line) => canRead(line.locationId)))
        ).every(Boolean)
      )
        visible.push(row);
      if (visible.length >= Math.max(0, Math.min(args.limit ?? 100, 250)))
        break;
    }
    return visible;
  },
});
