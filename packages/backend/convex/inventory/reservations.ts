import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  allocateTrackedSource,
  applyLotDelta,
  applySummaryDelta,
  findExistingCommand,
  hashPayload,
  postMovement,
  type PostingLine,
} from "./posting";
import { reservationStatusValidator } from "./validators";

const reservationLine = v.object({
  productId: v.id("products"),
  locationId: v.id("inventoryLocations"),
  quantityBase: v.int64(),
  lotId: v.optional(v.id("inventoryLots")),
});

export const create = mutation({
  args: {
    idempotencyKey: v.string(),
    reservationType: v.string(),
    sourceType: v.string(),
    sourceDocumentId: v.string(),
    expiresAt: v.optional(v.number()),
    lines: v.array(reservationLine),
  },
  returns: v.id("inventoryReservations"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const payloadHash = hashPayload(args);
    const duplicateCommand = await ctx.db
      .query("inventoryCommands")
      .withIndex("by_organizationId_and_idempotencyKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (duplicateCommand) {
      if (duplicateCommand.payloadHash !== payloadHash)
        throw new ConvexError("Idempotency key collision");
      const id = duplicateCommand.sourceDocumentId
        ? ctx.db.normalizeId(
            "inventoryReservations",
            duplicateCommand.sourceDocumentId,
          )
        : null;
      if (id) return id;
    }
    if (args.lines.length === 0)
      throw new ConvexError("Reservation needs lines");
    const now = Date.now();
    const reservationId = await ctx.db.insert("inventoryReservations", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      reservationNumber: `RS-${now.toString(36).toUpperCase()}`,
      reservationType: args.reservationType,
      sourceType: args.sourceType,
      sourceDocumentId: args.sourceDocumentId,
      status: "active",
      ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    const movementId = await ctx.db.insert("inventoryMovements", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      movementNumber: `MV-${now.toString(36).toUpperCase()}-RS`,
      movementType: "reservation",
      sourceType: args.sourceType,
      sourceDocumentId: reservationId,
      status: "posted",
      effectiveAt: now,
      postedAt: now,
      postedBy: identity.tokenIdentifier,
      idempotencyKey: args.idempotencyKey,
      schemaVersion: 1,
    });
    for (const [index, input] of args.lines.entries()) {
      if (input.quantityBase <= 0n)
        throw new ConvexError("Reservation quantity must be positive");
      const [product, location] = await Promise.all([
        ctx.db.get(input.productId),
        ctx.db.get(input.locationId),
      ]);
      if (!product || !location)
        throw new ConvexError("Reservation product/location not found");
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", input.productId),
        )
        .unique();
      const movementLineId = await ctx.db.insert("inventoryMovementLines", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        movementId,
        lineNumber: index + 1,
        productId: input.productId,
        ...(policy?.baseUomId ? { baseUomId: policy.baseUomId } : {}),
        quantityBase: input.quantityBase,
        fromLocationId: input.locationId,
        fromStockStatus: "available",
        sourceLineId: `${reservationId}:${index + 1}`,
        reasonCode: "hard_reservation",
        effectiveAt: now,
      });
      const summary = await applySummaryDelta(ctx, {
        product,
        location,
        status: "available",
        quantityDeltaBase: 0n,
        physicalDeltaBase: 0n,
        reservedDeltaBase: input.quantityBase,
        movementId,
        now,
      });
      let allocations: Awaited<ReturnType<typeof allocateTrackedSource>> = [];
      if (policy?.trackingMode === "lot") {
        const line: PostingLine = {
          productId: input.productId,
          quantityBase: input.quantityBase,
          fromLocationId: input.locationId,
          fromStockStatus: "available",
          allocations: input.lotId
            ? [
                {
                  lotId: input.lotId,
                  quantityBase: input.quantityBase,
                  userSelected: true,
                },
              ]
            : undefined,
        };
        allocations = await allocateTrackedSource(ctx, line, policy);
      }
      for (const [allocationIndex, allocation] of allocations.entries()) {
        const allocationId = await ctx.db.insert("inventoryAllocations", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          movementId,
          movementLineId,
          productId: input.productId,
          lotId: allocation.lotId,
          quantityBase: allocation.quantityBase,
          fromLocationId: input.locationId,
          fromStockStatus: "available",
          allocationSequence: allocationIndex + 1,
          allocationPolicy: policy!.allocationPolicy,
          userSelected: Boolean(input.lotId),
          effectiveAt: now,
        });
        const lotResult = await applyLotDelta(ctx, {
          productId: input.productId,
          lotId: allocation.lotId,
          locationId: input.locationId,
          status: "available",
          quantityDeltaBase: 0n,
          reservedDeltaBase: allocation.quantityBase,
          movementId,
          now,
        });
        await ctx.db.insert("inventoryLedgerEntries", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          movementId,
          movementLineId,
          allocationId,
          productId: input.productId,
          lotId: allocation.lotId,
          locationId: input.locationId,
          stockStatus: "available",
          quantityDeltaBase: 0n,
          reservedDeltaBase: allocation.quantityBase,
          balanceVersion: lotResult.version,
          quantityBeforeBase: lotResult.before,
          quantityAfterBase: lotResult.after,
          effectiveAt: now,
          postedAt: now,
        });
        await ctx.db.insert("inventoryReservationLines", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          reservationId,
          productId: input.productId,
          locationId: input.locationId,
          lotId: allocation.lotId,
          requestedBase: allocation.quantityBase,
          reservedBase: allocation.quantityBase,
          consumedBase: 0n,
          releasedBase: 0n,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (allocations.length === 0) {
        await ctx.db.insert("inventoryLedgerEntries", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          movementId,
          movementLineId,
          productId: input.productId,
          locationId: input.locationId,
          stockStatus: "available",
          quantityDeltaBase: 0n,
          reservedDeltaBase: input.quantityBase,
          balanceVersion: summary.version,
          quantityBeforeBase: summary.before,
          quantityAfterBase: summary.after,
          effectiveAt: now,
          postedAt: now,
        });
        await ctx.db.insert("inventoryReservationLines", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          reservationId,
          productId: input.productId,
          locationId: input.locationId,
          requestedBase: input.quantityBase,
          reservedBase: input.quantityBase,
          consumedBase: 0n,
          releasedBase: 0n,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    await ctx.db.insert("inventoryCommands", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      idempotencyKey: args.idempotencyKey,
      commandType: "reservation.create",
      schemaVersion: 1,
      payloadHash,
      actorSubject: identity.tokenIdentifier,
      status: "posted",
      sourceDocumentId: reservationId,
      movementId,
      result: { reservationId, movementId },
      createdAt: now,
      committedAt: now,
    });
    return reservationId;
  },
});

export const release = mutation({
  args: {
    reservationId: v.id("inventoryReservations"),
    idempotencyKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const payloadHash = hashPayload(args);
    const duplicate = await findExistingCommand(
      ctx,
      args.idempotencyKey,
      payloadHash,
    );
    if (duplicate) return null;
    const reservation = await ctx.db.get(args.reservationId);
    if (
      !reservation ||
      !["active", "partially_consumed"].includes(reservation.status)
    )
      throw new ConvexError("Reservation is not releasable");
    const lines = await ctx.db
      .query("inventoryReservationLines")
      .withIndex("by_organizationId_and_reservationId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("reservationId", reservation._id),
      )
      .take(100);
    const now = Date.now();
    const movementId = await ctx.db.insert("inventoryMovements", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      movementNumber: `MV-${now.toString(36).toUpperCase()}-RR`,
      movementType: "reservation_release",
      sourceType: reservation.sourceType,
      sourceDocumentId: reservation._id,
      status: "posted",
      effectiveAt: now,
      postedAt: now,
      postedBy: identity.tokenIdentifier,
      idempotencyKey: args.idempotencyKey,
      schemaVersion: 1,
    });
    for (const [index, line] of lines.entries()) {
      const outstanding =
        line.reservedBase - line.consumedBase - line.releasedBase;
      if (outstanding <= 0n) continue;
      const [product, location] = await Promise.all([
        ctx.db.get(line.productId),
        ctx.db.get(line.locationId),
      ]);
      if (!product || !location)
        throw new ConvexError("Reservation balance target missing");
      const movementLineId = await ctx.db.insert("inventoryMovementLines", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        movementId,
        lineNumber: index + 1,
        productId: line.productId,
        quantityBase: outstanding,
        fromLocationId: line.locationId,
        fromStockStatus: "available",
        sourceLineId: line._id,
        reasonCode: "reservation_release",
        effectiveAt: now,
      });
      const result = await applySummaryDelta(ctx, {
        product,
        location,
        status: "available",
        quantityDeltaBase: 0n,
        physicalDeltaBase: 0n,
        reservedDeltaBase: -outstanding,
        movementId,
        now,
      });
      if (line.lotId)
        await applyLotDelta(ctx, {
          productId: line.productId,
          lotId: line.lotId,
          locationId: line.locationId,
          status: "available",
          quantityDeltaBase: 0n,
          reservedDeltaBase: -outstanding,
          movementId,
          now,
        });
      await ctx.db.insert("inventoryLedgerEntries", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        movementId,
        movementLineId,
        productId: line.productId,
        ...(line.lotId ? { lotId: line.lotId } : {}),
        locationId: line.locationId,
        stockStatus: "available",
        quantityDeltaBase: 0n,
        reservedDeltaBase: -outstanding,
        balanceVersion: result.version,
        quantityBeforeBase: result.before,
        quantityAfterBase: result.after,
        effectiveAt: now,
        postedAt: now,
      });
      await ctx.db.patch(line._id, {
        releasedBase: line.releasedBase + outstanding,
        updatedAt: now,
      });
    }
    await ctx.db.patch(reservation._id, { status: "released", updatedAt: now });
    await ctx.db.insert("inventoryCommands", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      idempotencyKey: args.idempotencyKey,
      commandType: "reservation.release",
      schemaVersion: 1,
      payloadHash,
      actorSubject: identity.tokenIdentifier,
      status: "posted",
      sourceDocumentId: reservation._id,
      movementId,
      result: { reservationId: reservation._id, movementId },
      createdAt: now,
      committedAt: now,
    });
    return null;
  },
});

export const consume = mutation({
  args: {
    reservationId: v.id("inventoryReservations"),
    idempotencyKey: v.string(),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const payloadHash = hashPayload(args);
    const duplicate = await findExistingCommand(
      ctx,
      args.idempotencyKey,
      payloadHash,
    );
    if (duplicate?.movementId) return duplicate.movementId;
    const reservation = await ctx.db.get(args.reservationId);
    if (
      !reservation ||
      !["active", "partially_consumed"].includes(reservation.status)
    )
      throw new ConvexError("Reservation is not consumable");
    const lines = await ctx.db
      .query("inventoryReservationLines")
      .withIndex("by_organizationId_and_reservationId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("reservationId", reservation._id),
      )
      .take(100);
    const postingLines: PostingLine[] = [];
    for (const line of lines) {
      const outstanding =
        line.reservedBase - line.consumedBase - line.releasedBase;
      if (outstanding <= 0n) continue;
      postingLines.push({
        productId: line.productId,
        quantityBase: outstanding,
        fromLocationId: line.locationId,
        fromStockStatus: "available",
        sourceReservedDeltaBase: -outstanding,
        allocations: line.lotId
          ? [
              {
                lotId: line.lotId,
                quantityBase: outstanding,
                userSelected: true,
              },
            ]
          : undefined,
        sourceLineId: line._id,
        reasonCode: "reservation_consumption",
      });
    }
    if (postingLines.length === 0)
      throw new ConvexError("Reservation has no outstanding quantity");
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash,
      commandType: "reservation.consume",
      movementType: "inventory_issue",
      sourceType: reservation.sourceType,
      sourceDocumentId: reservation._id,
      actorSubject: identity.tokenIdentifier,
      lines: postingLines,
    });
    const now = Date.now();
    for (const line of lines) {
      const outstanding =
        line.reservedBase - line.consumedBase - line.releasedBase;
      if (outstanding > 0n)
        await ctx.db.patch(line._id, {
          consumedBase: line.consumedBase + outstanding,
          updatedAt: now,
        });
    }
    await ctx.db.patch(reservation._id, {
      status: "consumed",
      updatedAt: now,
    });
    return movement.movementId;
  },
});

export const list = query({
  args: {
    status: v.optional(reservationStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    if (args.status)
      return ctx.db
        .query("inventoryReservations")
        .withIndex("by_organizationId_and_status_and_expiresAt", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("status", args.status!),
        )
        .take(Math.min(args.limit ?? 100, 250));
    return ctx.db
      .query("inventoryReservations")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 250));
  },
});
