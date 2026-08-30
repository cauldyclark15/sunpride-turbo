import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

const taskValue = v.object({
  _id: v.id("integrationEvents"),
  eventId: v.string(),
  eventType: v.string(),
  payload: v.any(),
  attempts: v.number(),
});

export const recordInbound = internalMutation({
  args: { eventId: v.string(), eventType: v.string(), payload: v.any() },
  returns: v.object({ duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("integrationEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (duplicate) return { duplicate: true };
    const now = Date.now();
    await ctx.db.insert("integrationEvents", {
      eventId: args.eventId,
      direction: "inbound",
      eventType: args.eventType,
      status: "completed",
      attempts: 1,
      payload: args.payload,
      receivedAt: now,
      processedAt: now,
    });
    if (args.eventType === "inventory.snapshot") {
      const payload = args.payload as {
        productCode?: string;
        warehouseCode?: string;
        onHand?: number;
        reserved?: number;
        available?: number;
        asOf?: string;
      };
      if (payload.productCode && payload.warehouseCode) {
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
          asOf: payload.asOf ? Date.parse(payload.asOf) : now,
        };
        if (existing) await ctx.db.patch(existing._id, balance);
        else await ctx.db.insert("inventoryBalances", balance);
      }
    }
    return { duplicate: false };
  },
});

export const pendingTasks = internalQuery({
  args: { limit: v.number() },
  returns: v.array(taskValue),
  handler: async (ctx, args) => {
    const tasks = await ctx.db
      .query("integrationEvents")
      .withIndex("by_direction_status", (q) =>
        q.eq("direction", "outbound").eq("status", "pending"),
      )
      .take(Math.min(args.limit, 25));
    return tasks.map(({ _id, eventId, eventType, payload, attempts }) => ({
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
    await ctx.db.patch(event._id, {
      status: args.success
        ? "completed"
        : event.attempts >= 9
          ? "dead_letter"
          : "pending",
      attempts: event.attempts + 1,
      processedAt: args.success ? Date.now() : undefined,
      lastError: args.error,
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
