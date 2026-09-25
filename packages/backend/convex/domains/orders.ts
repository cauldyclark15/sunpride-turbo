import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds, rootOrgUnitId } from "../lib/scope";
import { readableLocationIds } from "../inventory/location_scope";
import { adjustMetrics } from "../lib/metrics";

/** Legacy customer territory is text; only active, territory-matching assignments to
 * currently scoped profiles establish ownership. Unmapped customers fail closed. */
export async function customerAccessible(
  ctx: QueryCtx | MutationCtx,
  customer: Doc<"customers">,
  profile: Doc<"profiles">,
  subject: string,
  ownAssignment = false,
) {
  if (!customer.active) return false;
  if (profile.role === "super_admin") return true;
  const root = await rootOrgUnitId(ctx);
  const national =
    profile.role === "analyst" || (!!root && profile.orgUnitId === root);
  if (national && !ownAssignment) return true;
  if (!profile.orgUnitId) return false;
  const units = new Set(await collectScopeUnitIds(ctx, profile.orgUnitId));
  const assignments = await ctx.db
    .query("salesAssignments")
    .withIndex("by_customer", (q) => q.eq("customerCode", customer.code))
    .take(101);
  if (assignments.length > 100)
    throw new ConvexError("Customer assignments exceed supported limit");
  for (const assignment of assignments) {
    if (
      !assignment.active ||
      assignment.territory !== customer.territory ||
      (ownAssignment && assignment.salespersonSubject !== subject)
    )
      continue;
    const owner = await ctx.db
      .query("profiles")
      .withIndex("by_subject", (q) =>
        q.eq("authSubject", assignment.salespersonSubject),
      )
      .unique();
    if (
      owner?.status === "active" &&
      owner.orgUnitId &&
      units.has(owner.orgUnitId)
    )
      return true;
  }
  return false;
}

/** Read the persisted creator and customer, not a client-provided unit. */
export async function orderAccessible(
  ctx: QueryCtx | MutationCtx,
  orderRow: Doc<"orders">,
  profile: Doc<"profiles">,
  subject: string,
) {
  if (profile.role === "super_admin") return true;
  if (profile.role === "sales" && orderRow.salespersonSubject !== subject)
    return false;
  const root = await rootOrgUnitId(ctx);
  if (profile.role === "analyst" || (root && profile.orgUnitId === root))
    return true;
  if (!profile.orgUnitId) return false;
  const owner = await ctx.db
    .query("profiles")
    .withIndex("by_subject", (q) =>
      q.eq("authSubject", orderRow.salespersonSubject),
    )
    .unique();
  if (!owner?.orgUnitId || owner.status !== "active") return false;
  const units = await collectScopeUnitIds(ctx, profile.orgUnitId);
  if (!units.includes(owner.orgUnitId)) return false;
  if (orderRow.sourceLocationId) {
    const readable = await readableLocationIds(ctx);
    if (!(await readable(orderRow.sourceLocationId))) return false;
  }
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_code", (q) => q.eq("code", orderRow.customerCode))
    .unique();
  return (
    !!customer &&
    (await customerAccessible(
      ctx,
      customer,
      profile,
      subject,
      profile.role === "sales",
    ))
  );
}

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
    const { identity, profile } = await requireCapability(ctx, "report.read");
    if (args.status === "pending_approval")
      await requireCapability(ctx, "order.approve");
    const rows =
      args.status === "pending_approval"
        ? await ctx.db
            .query("orders")
            .withIndex("by_status", (q) => q.eq("status", "pending_approval"))
            .take(100)
        : await ctx.db
            .query("orders")
            .withIndex("by_created_at")
            .order("desc")
            .take(100);
    const visible = [];
    for (const row of rows)
      if (await orderAccessible(ctx, row, profile, identity.tokenIdentifier))
        visible.push(row);
    return visible;
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
    const { identity, profile } = await requireCapability(ctx, "order.create");
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_code", (q) => q.eq("code", args.customerCode))
      .unique();
    if (
      !customer ||
      !(await customerAccessible(
        ctx,
        customer,
        profile,
        identity.tokenIdentifier,
        profile.role === "sales",
      ))
    )
      throw new ConvexError("Customer is not assigned within your scope");
    const duplicate = await ctx.db
      .query("orders")
      .withIndex("by_client_request", (q) =>
        q.eq("clientRequestId", args.clientRequestId),
      )
      .unique();
    if (duplicate) {
      if (
        duplicate.salespersonSubject !== identity.tokenIdentifier ||
        !(await orderAccessible(
          ctx,
          duplicate,
          profile,
          identity.tokenIdentifier,
        ))
      )
        throw new ConvexError("Request ID belongs to another order");
      return duplicate._id;
    }
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
    const target = await ctx.db.get(args.orderId);
    if (!target) throw new ConvexError("Order not found");
    const { identity, profile } = await requireCapability(ctx, "order.approve");
    if (
      !(await orderAccessible(ctx, target, profile, identity.tokenIdentifier))
    )
      throw new ConvexError("Order is outside your organizational scope");
    if (target.salespersonSubject === identity.tokenIdentifier)
      throw new ConvexError("Requester cannot approve own order");
    if (target.status !== "pending_approval")
      throw new ConvexError("Order is not pending approval");
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
