import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  DEFAULT_QUANTITY_SCALE,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import {
  hashPayload,
  postMovement,
  type PostingLine,
} from "../inventory/posting";
import type { MovementType, StockStatus } from "../inventory/validators";

const taskValue = v.object({
  _id: v.id("integrationEvents"),
  eventId: v.string(),
  eventType: v.string(),
  payload: v.any(),
  attempts: v.number(),
});

const stockStatuses = new Set<StockStatus>([
  "available",
  "quality_hold",
  "quarantine",
  "damaged",
  "expired",
  "rejected",
  "wip",
  "in_transit",
]);

export const recordInbound = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    payload: v.any(),
    contractVersion: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    sourceSequence: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    payloadHash: v.optional(v.string()),
  },
  returns: v.object({ duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("integrationEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (duplicate) return { duplicate: true };
    const now = Date.now();
    const eventRecordId = await ctx.db.insert("integrationEvents", {
      eventId: args.eventId,
      direction: "inbound",
      eventType: args.eventType,
      status: "completed",
      attempts: 1,
      payload: args.payload,
      receivedAt: now,
      processedAt: now,
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      schemaVersion: Number(args.contractVersion?.split(".")[0] ?? 1),
      payloadHash: args.payloadHash ?? hashPayload(args.payload),
      correlationId: args.correlationId,
    });
    if (args.eventType === "inventory.snapshot") {
      const payload = args.payload as {
        productCode?: string;
        warehouseCode?: string;
        onHand?: number;
        reserved?: number;
        available?: number;
        onHandBase?: string;
        reservedBase?: string;
        availableBase?: string;
        asOf?: string;
      };
      if (payload.productCode && payload.warehouseCode) {
        const [product, location] = await Promise.all([
          ctx.db
            .query("products")
            .withIndex("by_code", (q) => q.eq("code", payload.productCode!))
            .unique(),
          ctx.db
            .query("inventoryLocations")
            .withIndex("by_organizationId_and_code", (q) =>
              q
                .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                .eq("code", payload.warehouseCode!),
            )
            .unique(),
        ]);
        const scale = product?.quantityScale ?? DEFAULT_QUANTITY_SCALE;
        const onHandBase = payload.onHandBase
          ? BigInt(payload.onHandBase)
          : BigInt(Math.round((payload.onHand ?? 0) * Number(scale)));
        const reservedBase = payload.reservedBase
          ? BigInt(payload.reservedBase)
          : BigInt(Math.round((payload.reserved ?? 0) * Number(scale)));
        const availableBase = payload.availableBase
          ? BigInt(payload.availableBase)
          : BigInt(Math.round((payload.available ?? 0) * Number(scale)));
        const asOf = payload.asOf
          ? Date.parse(payload.asOf)
          : (args.occurredAt ?? now);
        await ctx.db.insert("sapInventorySnapshots", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          productCode: payload.productCode,
          warehouseCode: payload.warehouseCode,
          ...(product ? { productId: product._id } : {}),
          ...(location ? { locationId: location._id } : {}),
          onHandBase,
          reservedBase,
          availableBase,
          asOf,
          sourceEventId: args.eventId,
          ...(args.sourceSequence
            ? { sourceSequence: args.sourceSequence }
            : {}),
          payloadHash: args.payloadHash ?? hashPayload(args.payload),
          resolutionStatus: product && location ? "pending" : "unmapped",
          receivedAt: now,
        });
        const operational =
          product && location
            ? await ctx.db
                .query("inventoryBalances")
                .withIndex(
                  "by_organizationId_and_productId_and_locationId",
                  (q) =>
                    q
                      .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                      .eq("productId", product._id)
                      .eq("locationId", location._id),
                )
                .unique()
            : null;
        const existing = await ctx.db
          .query("inventoryBalances")
          .withIndex("by_product_warehouse", (q) =>
            q
              .eq("productCode", payload.productCode!)
              .eq("warehouseCode", payload.warehouseCode!),
          )
          .unique();
        const balance = {
          productCode: payload.productCode,
          warehouseCode: payload.warehouseCode,
          onHand: payload.onHand ?? 0,
          reserved: payload.reserved ?? 0,
          available: payload.available ?? 0,
          asOf,
        };
        if (!operational) {
          if (existing) await ctx.db.patch(existing._id, balance);
          else await ctx.db.insert("inventoryBalances", balance);
        }
      }
    }
    if (args.eventType === "inventory.movement.approved") {
      const payload = args.payload as {
        movementType?: string;
        documentId?: string;
        reasonCode?: string;
        lines?: {
          productCode?: string;
          quantityBase?: string;
          fromLocationCode?: string;
          toLocationCode?: string;
          fromStatus?: string;
          toStatus?: string;
          lotNumber?: string;
          manufacturedAt?: string;
          expiresAt?: string;
          unitCostMinor?: string;
        }[];
      };
      const allowedMovementTypes = new Set<MovementType>([
        "goods_receipt",
        "inventory_issue",
        "inventory_adjustment",
        "status_change",
      ]);
      const movementType = allowedMovementTypes.has(
        payload.movementType as MovementType,
      )
        ? (payload.movementType as MovementType)
        : "inventory_adjustment";
      if (!payload.lines?.length)
        throw new Error("SAP inventory movement has no lines");
      const lines: PostingLine[] = [];
      for (const input of payload.lines) {
        if (!input.productCode || !input.quantityBase)
          throw new Error("SAP movement line is missing product or quantity");
        const product = await ctx.db
          .query("products")
          .withIndex("by_code", (q) => q.eq("code", input.productCode!))
          .unique();
        if (!product)
          throw new Error(`Unmapped SAP product ${input.productCode}`);
        const fromLocation = input.fromLocationCode
          ? await ctx.db
              .query("inventoryLocations")
              .withIndex("by_organizationId_and_code", (q) =>
                q
                  .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                  .eq("code", input.fromLocationCode!),
              )
              .unique()
          : null;
        const toLocation = input.toLocationCode
          ? await ctx.db
              .query("inventoryLocations")
              .withIndex("by_organizationId_and_code", (q) =>
                q
                  .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                  .eq("code", input.toLocationCode!),
              )
              .unique()
          : null;
        if (
          (input.fromLocationCode && !fromLocation) ||
          (input.toLocationCode && !toLocation)
        )
          throw new Error("SAP movement contains an unmapped location");
        const policy = await ctx.db
          .query("productInventoryPolicies")
          .withIndex("by_organizationId_and_productId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", product._id),
          )
          .unique();
        let lotId;
        if (policy?.trackingMode === "lot") {
          if (!input.lotNumber)
            throw new Error(`SAP movement for ${product.code} requires a lot`);
          const normalizedLotNumber = input.lotNumber.trim().toUpperCase();
          let lot = await ctx.db
            .query("inventoryLots")
            .withIndex(
              "by_organizationId_and_productId_and_normalizedLotNumber",
              (q) =>
                q
                  .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                  .eq("productId", product._id)
                  .eq("normalizedLotNumber", normalizedLotNumber),
            )
            .unique();
          if (!lot && toLocation) {
            const manufacturedAt = input.manufacturedAt
              ? Date.parse(input.manufacturedAt)
              : undefined;
            const expiresAt = input.expiresAt
              ? Date.parse(input.expiresAt)
              : undefined;
            if (policy.expiryDateRequired && !expiresAt)
              throw new Error(
                `SAP movement for ${product.code} requires expiry`,
              );
            const id = await ctx.db.insert("inventoryLots", {
              organizationId: SUNPRIDE_ORGANIZATION_ID,
              productId: product._id,
              lotNumber: input.lotNumber,
              normalizedLotNumber,
              sourceType: "sap_inventory_movement",
              sourceDocumentId: payload.documentId,
              ...(manufacturedAt ? { manufacturedAt } : {}),
              receivedAt: now,
              ...(expiresAt ? { expiresAt } : {}),
              qualityStatus: "released",
              ...(input.unitCostMinor
                ? { unitCostMinor: BigInt(input.unitCostMinor) }
                : {}),
              createdAt: now,
              updatedAt: now,
            });
            lot = await ctx.db.get(id);
          }
          if (!lot) throw new Error(`SAP lot ${input.lotNumber} was not found`);
          lotId = lot._id;
        }
        const quantityBase = BigInt(input.quantityBase);
        if (quantityBase <= 0n)
          throw new Error("SAP movement quantity must be positive");
        if (
          (input.fromStatus &&
            !stockStatuses.has(input.fromStatus as StockStatus)) ||
          (input.toStatus && !stockStatuses.has(input.toStatus as StockStatus))
        )
          throw new Error("SAP movement contains an invalid stock status");
        lines.push({
          productId: product._id,
          quantityBase,
          ...(fromLocation ? { fromLocationId: fromLocation._id } : {}),
          ...(toLocation ? { toLocationId: toLocation._id } : {}),
          ...(input.fromStatus
            ? { fromStockStatus: input.fromStatus as StockStatus }
            : {}),
          ...(input.toStatus
            ? { toStockStatus: input.toStatus as StockStatus }
            : {}),
          ...(lotId
            ? {
                allocations: [{ lotId, quantityBase, userSelected: true }],
              }
            : {}),
          ...(input.unitCostMinor
            ? { unitCostMinor: BigInt(input.unitCostMinor) }
            : {}),
          reasonCode: payload.reasonCode ?? "sap_approved_movement",
        });
      }
      const movement = await postMovement(ctx, {
        idempotencyKey: `sap:${args.eventId}`,
        payloadHash: args.payloadHash ?? hashPayload(args.payload),
        commandType: "sap.inventoryMovement.approved",
        movementType,
        sourceType: "sap",
        sourceDocumentId: payload.documentId ?? args.eventId,
        actorSubject: `sap:${args.eventId}`,
        reasonCode: payload.reasonCode,
        effectiveAt: args.occurredAt,
        lines,
        emitIntegrationEvent: false,
      });
      await ctx.db.patch(eventRecordId, {
        movementId: movement.movementId,
        sourceDocumentId: payload.documentId,
      });
    }
    return { duplicate: false };
  },
});

export const pendingTasks = internalQuery({
  args: { limit: v.number(), now: v.number() },
  returns: v.array(taskValue),
  handler: async (ctx, args) => {
    const tasks = await ctx.db
      .query("integrationEvents")
      .withIndex("by_direction_status", (q) =>
        q.eq("direction", "outbound").eq("status", "pending"),
      )
      .take(Math.min(args.limit, 25));
    return tasks
      .filter((task) => !task.nextAttemptAt || task.nextAttemptAt <= args.now)
      .map(({ _id, eventId, eventType, payload, attempts }) => ({
        _id,
        eventId,
        eventType,
        payload,
        attempts,
      }));
  },
});

export const acknowledgeTask = internalMutation({
  args: {
    eventId: v.string(),
    success: v.boolean(),
    sapDocumentNumber: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("integrationEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (!event) return null;
    const now = Date.now();
    await ctx.db.patch(event._id, {
      status: args.success
        ? "completed"
        : event.attempts >= 9
          ? "dead_letter"
          : "pending",
      attempts: event.attempts + 1,
      ...(args.success ? { processedAt: now, acknowledgedAt: now } : {}),
      ...(!args.success
        ? { nextAttemptAt: now + Math.min(60_000, 1000 * 2 ** event.attempts) }
        : {}),
      lastError: args.error,
      ...(args.sapDocumentNumber
        ? {
            externalDocumentNumber: args.sapDocumentNumber,
          }
        : {}),
    });
    if (args.success && event.eventType === "sales-order.submit") {
      const payload = event.payload as { orderId?: string };
      if (payload.orderId) {
        const orderId = ctx.db.normalizeId("orders", payload.orderId);
        if (orderId)
          await ctx.db.patch(orderId, {
            status: "sent_to_sap",
            sapDocumentNumber: args.sapDocumentNumber,
            updatedAt: Date.now(),
          });
      }
    }
    return null;
  },
});

export const heartbeat = internalMutation({
  args: {
    connectorId: v.string(),
    status: v.union(
      v.literal("online"),
      v.literal("degraded"),
      v.literal("offline"),
    ),
    adapter: v.string(),
    details: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("connectorHeartbeats")
      .withIndex("by_connector", (q) => q.eq("connectorId", args.connectorId))
      .unique();
    const payload = { ...args, lastSeenAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, payload);
    else await ctx.db.insert("connectorHeartbeats", payload);
    return null;
  },
});
