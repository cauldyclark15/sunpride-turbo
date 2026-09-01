import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireIdentity, requireRole } from "../lib/auth";
import { adjustMetrics } from "../lib/metrics";

const order = v.object({
  _id: v.id("orders"),
  _creationTime: v.number(),
  clientRequestId: v.string(),
  orderNumber: v.string(),
  customerCode: v.string(),
  salespersonSubject: v.string(),
  status: v.union(
    v.literal("draft"),
    v.literal("submitted"),
    v.literal("pending_approval"),
    v.literal("approved"),
    v.literal("rejected"),
    v.literal("sent_to_sap"),
    v.literal("fulfilled"),
    v.literal("posted"),
    v.literal("partially_voided"),
    v.literal("voided"),
    v.literal("returned"),
    v.literal("review_required"),
  ),
  subtotal: v.number(),
  total: v.number(),
  offlineCreatedAt: v.optional(v.number()),
  sapDocumentNumber: v.optional(v.string()),
  organizationId: v.optional(v.string()),
  orderType: v.optional(v.string()),
  sourceLocationId: v.optional(v.id("inventoryLocations")),
  routeSessionId: v.optional(v.id("truckRouteSessions")),
  deviceId: v.optional(v.string()),
  deviceSequence: v.optional(v.number()),
  requestPayloadHash: v.optional(v.string()),
  inventoryMovementId: v.optional(v.id("inventoryMovements")),
  voidMovementId: v.optional(v.id("inventoryMovements")),
  originalOrderId: v.optional(v.id("orders")),
  voidedAt: v.optional(v.number()),
  voidedBy: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const list = query({
  args: { status: v.optional(v.string()) },
  returns: v.array(order),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    if (args.status === "pending_approval")
      return ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", "pending_approval"))
        .take(100);
    return ctx.db
      .query("orders")
      .withIndex("by_created_at")
      .order("desc")
      .take(100);
  },
});

export const create = mutation({
  args: {
    clientRequestId: v.string(),
    customerCode: v.string(),
    offlineCreatedAt: v.optional(v.number()),
    lines: v.array(
      v.object({
        productCode: v.string(),
        description: v.string(),
        quantity: v.number(),
        unitPrice: v.number(),
      }),
    ),
  },
  returns: v.id("orders"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const duplicate = await ctx.db
      .query("orders")
      .withIndex("by_client_request", (q) =>
        q.eq("clientRequestId", args.clientRequestId),
      )
      .unique();
    if (duplicate) return duplicate._id;
    if (args.lines.length === 0)
      throw new ConvexError("At least one order line is required");
    const total = args.lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPrice,
      0,
    );
    const now = Date.now();
    const orderId = await ctx.db.insert("orders", {
      clientRequestId: args.clientRequestId,
      orderNumber: `SP-${now.toString(36).toUpperCase()}`,
      customerCode: args.customerCode,
      salespersonSubject: identity.tokenIdentifier,
      status: "pending_approval",
      subtotal: total,
      total,
      offlineCreatedAt: args.offlineCreatedAt,
      createdAt: now,
      updatedAt: now,
    });
    for (const line of args.lines)
      await ctx.db.insert("orderLines", {
        orderId,
        ...line,
        lineTotal: line.quantity * line.unitPrice,
      });
    const workflowId = await ctx.db.insert("workflowInstances", {
      entityType: "order",
      entityId: orderId,
      workflowType: "sales-order-approval",
      status: "pending",
      currentStep: 1,
      requestedBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("approvals", { workflowId, decision: "pending" });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "order.created",
      entityType: "order",
      entityId: orderId,
      createdAt: now,
    });
    await adjustMetrics(ctx, {
      openOrderCount: 1,
      pendingApprovalCount: 1,
      salesToday: total,
    });
    return orderId;
  },
});

export const decide = mutation({
  args: {
    orderId: v.id("orders"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    comment: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, [
      "admin",
      "manager",
      "approver",
    ]);
    const target = await ctx.db.get(args.orderId);
    if (!target) throw new ConvexError("Order not found");
    const workflow = await ctx.db
      .query("workflowInstances")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", "order").eq("entityId", args.orderId),
      )
      .unique();
    if (!workflow) throw new ConvexError("Approval workflow not found");
    const approval = await ctx.db
      .query("approvals")
      .withIndex("by_workflow", (q) => q.eq("workflowId", workflow._id))
      .unique();
    const now = Date.now();
    await ctx.db.patch(args.orderId, { status: args.decision, updatedAt: now });
    await ctx.db.patch(workflow._id, { status: args.decision, updatedAt: now });
    if (approval)
      await ctx.db.patch(approval._id, {
        approverSubject: identity.tokenIdentifier,
        decision: args.decision,
        comment: args.comment,
        decidedAt: now,
      });
    if (args.decision === "approved")
      await ctx.db.insert("integrationEvents", {
        eventId: `order-${args.orderId}`,
        direction: "outbound",
        eventType: "sales-order.submit",
        status: "pending",
        attempts: 0,
        payload: {
          orderId: args.orderId,
          orderNumber: target.orderNumber,
          customerCode: target.customerCode,
          total: target.total,
        },
        receivedAt: now,
      });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: `order.${args.decision}`,
      entityType: "order",
      entityId: args.orderId,
      details: args.comment,
      createdAt: now,
    });
    await adjustMetrics(ctx, { pendingApprovalCount: -1 });
    return null;
  },
});
