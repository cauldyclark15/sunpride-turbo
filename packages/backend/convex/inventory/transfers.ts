import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireIdentity, requireRole } from "../lib/auth";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import { hashPayload, postMovement, type PostingLine } from "./posting";
import { transferStatusValidator } from "./validators";

const transferLineInput = v.object({
  productId: v.id("products"),
  quantityBase: v.int64(),
});

export const request = mutation({
  args: {
    sourceLocationId: v.id("inventoryLocations"),
    destinationLocationId: v.id("inventoryLocations"),
    inTransitLocationId: v.id("inventoryLocations"),
    routeSessionId: v.optional(v.id("truckRouteSessions")),
    note: v.optional(v.string()),
    lines: v.array(transferLineInput),
  },
  returns: v.id("stockTransfers"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (args.lines.length === 0)
      throw new ConvexError("Transfer needs at least one line");
    if (args.sourceLocationId === args.destinationLocationId)
      throw new ConvexError("Transfer source and destination must differ");
    const now = Date.now();
    const transferId = await ctx.db.insert("stockTransfers", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      transferNumber: `TR-${now.toString(36).toUpperCase()}`,
      sourceLocationId: args.sourceLocationId,
      destinationLocationId: args.destinationLocationId,
      inTransitLocationId: args.inTransitLocationId,
      status: "requested",
      requestedBy: identity.tokenIdentifier,
      ...(args.routeSessionId ? { routeSessionId: args.routeSessionId } : {}),
      ...(args.note ? { note: args.note } : {}),
      createdAt: now,
      updatedAt: now,
    });
    for (const line of args.lines) {
      if (line.quantityBase <= 0n)
        throw new ConvexError("Transfer quantity must be positive");
      await ctx.db.insert("stockTransferLines", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        transferId,
        productId: line.productId,
        requestedBase: line.quantityBase,
        approvedBase: 0n,
        shippedBase: 0n,
        receivedBase: 0n,
        rejectedBase: 0n,
        shortBase: 0n,
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.transfer.requested",
      entityType: "stockTransfer",
      entityId: transferId,
      details: args.note,
      createdAt: now,
    });
    return transferId;
  },
});

export const approve = mutation({
  args: { transferId: v.id("stockTransfers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, [
      "admin",
      "manager",
      "approver",
    ]);
    const transfer = await ctx.db.get(args.transferId);
    if (!transfer || transfer.status !== "requested")
      throw new ConvexError("Transfer is not awaiting approval");
    if (transfer.requestedBy === identity.tokenIdentifier)
      throw new ConvexError(
        "Transfer requester cannot approve the same transfer",
      );
    const lines = await ctx.db
      .query("stockTransferLines")
      .withIndex("by_organizationId_and_transferId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("transferId", transfer._id),
      )
      .take(100);
    const now = Date.now();
    for (const line of lines)
      await ctx.db.patch(line._id, {
        approvedBase: line.requestedBase,
        updatedAt: now,
      });
    await ctx.db.patch(transfer._id, {
      status: "approved",
      approvedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    return null;
  },
});

export const ship = mutation({
  args: {
    transferId: v.id("stockTransfers"),
    idempotencyKey: v.string(),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, ["admin", "manager", "sales"]);
    const transfer = await ctx.db.get(args.transferId);
    if (
      !transfer ||
      !["approved", "reserved", "picking"].includes(transfer.status)
    )
      throw new ConvexError(
        "Transfer cannot be shipped from its current state",
      );
    const transferLines = await ctx.db
      .query("stockTransferLines")
      .withIndex("by_organizationId_and_transferId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("transferId", transfer._id),
      )
      .take(100);
    const lines: PostingLine[] = transferLines.map((line) => ({
      productId: line.productId,
      quantityBase: line.approvedBase,
      fromLocationId: transfer.sourceLocationId,
      toLocationId: transfer.inTransitLocationId,
      fromStockStatus: "available",
      toStockStatus: "in_transit",
      sourceLineId: line._id,
      reasonCode: "transfer_ship",
    }));
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash: hashPayload({ transferId: args.transferId, lines }),
      commandType: "stockTransfer.ship",
      movementType: "transfer_ship",
      sourceType: "stock_transfer",
      sourceDocumentId: transfer._id,
      actorSubject: identity.tokenIdentifier,
      lines,
    });
    const now = Date.now();
    for (const line of transferLines)
      await ctx.db.patch(line._id, {
        shippedBase: line.approvedBase,
        updatedAt: now,
      });
    await ctx.db.patch(transfer._id, {
      status: "shipped",
      shippedBy: identity.tokenIdentifier,
      outboundMovementId: movement.movementId,
      updatedAt: now,
    });
    return movement.movementId;
  },
});

export const receive = mutation({
  args: {
    transferId: v.id("stockTransfers"),
    idempotencyKey: v.string(),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, ["admin", "manager", "sales"]);
    const transfer = await ctx.db.get(args.transferId);
    if (
      !transfer ||
      transfer.status !== "shipped" ||
      !transfer.outboundMovementId
    )
      throw new ConvexError("Transfer is not ready to receive");
    const outboundLines = await ctx.db
      .query("inventoryMovementLines")
      .withIndex("by_organizationId_and_movementId_and_lineNumber", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("movementId", transfer.outboundMovementId!),
      )
      .take(100);
    const lines: PostingLine[] = [];
    for (const line of outboundLines) {
      const allocations = await ctx.db
        .query("inventoryAllocations")
        .withIndex("by_organizationId_and_movementLineId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("movementLineId", line._id),
        )
        .take(50);
      lines.push({
        productId: line.productId,
        quantityBase: line.quantityBase,
        fromLocationId: transfer.inTransitLocationId,
        toLocationId: transfer.destinationLocationId,
        fromStockStatus: "in_transit",
        toStockStatus: "available",
        sourceLineId: line.sourceLineId,
        allocations:
          allocations.length > 0
            ? allocations.map((allocation) => ({
                lotId: allocation.lotId,
                quantityBase: allocation.quantityBase,
                userSelected: true,
              }))
            : undefined,
        reasonCode: "transfer_receive",
      });
    }
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash: hashPayload({
        transferId: args.transferId,
        outbound: transfer.outboundMovementId,
      }),
      commandType: "stockTransfer.receive",
      movementType: "transfer_receive",
      sourceType: "stock_transfer",
      sourceDocumentId: transfer._id,
      actorSubject: identity.tokenIdentifier,
      lines,
    });
    const transferLines = await ctx.db
      .query("stockTransferLines")
      .withIndex("by_organizationId_and_transferId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("transferId", transfer._id),
      )
      .take(100);
    const now = Date.now();
    for (const line of transferLines)
      await ctx.db.patch(line._id, {
        receivedBase: line.shippedBase,
        updatedAt: now,
      });
    await ctx.db.patch(transfer._id, {
      status: "received",
      receivedBy: identity.tokenIdentifier,
      receiptMovementId: movement.movementId,
      updatedAt: now,
    });
    return movement.movementId;
  },
});

export const cancel = mutation({
  args: { transferId: v.id("stockTransfers"), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, [
      "admin",
      "manager",
      "approver",
    ]);
    const transfer = await ctx.db.get(args.transferId);
    if (
      !transfer ||
      ["shipped", "partially_received", "received"].includes(transfer.status)
    )
      throw new ConvexError(
        "A shipped transfer must be returned, not cancelled",
      );
    await ctx.db.patch(transfer._id, {
      status: "cancelled",
      ...(args.note ? { note: args.note } : {}),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.transfer.cancelled",
      entityType: "stockTransfer",
      entityId: transfer._id,
      details: args.note,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const list = query({
  args: {
    status: v.optional(transferStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    if (args.status)
      return ctx.db
        .query("stockTransfers")
        .withIndex("by_organizationId_and_status_and_createdAt", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("status", args.status!),
        )
        .order("desc")
        .take(Math.min(args.limit ?? 100, 250));
    return ctx.db
      .query("stockTransfers")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 250));
  },
});
