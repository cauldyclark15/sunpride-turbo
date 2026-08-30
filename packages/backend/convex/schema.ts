import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(
  v.literal("super_admin"),
  v.literal("admin"),
  v.literal("manager"),
  v.literal("approver"),
  v.literal("sales"),
  v.literal("viewer"),
);
const orderStatus = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("pending_approval"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("sent_to_sap"),
  v.literal("fulfilled"),
);

export default defineSchema({
  profiles: defineTable({
    authSubject: v.string(),
    name: v.string(),
    email: v.string(),
    role,
    status: v.union(v.literal("active"), v.literal("disabled")),
    updatedAt: v.number(),
  })
    .index("by_subject", ["authSubject"])
    .index("by_email", ["email"])
    .index("by_role", ["role"]),
  accessInvitations: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    role,
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
    ),
    invitedBy: v.string(),
    invitedAt: v.number(),
    acceptedAt: v.optional(v.number()),
    profileId: v.optional(v.id("profiles")),
    updatedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_status", ["status"]),
  products: defineTable({
    code: v.string(),
    name: v.string(),
    category: v.string(),
    uom: v.string(),
    unitPrice: v.number(),
    active: v.boolean(),
    externalId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_category", ["category"]),
  customers: defineTable({
    code: v.string(),
    name: v.string(),
    channel: v.string(),
    territory: v.string(),
    creditLimit: v.number(),
    active: v.boolean(),
    externalId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_territory", ["territory"]),
  warehouses: defineTable({
    code: v.string(),
    name: v.string(),
    location: v.string(),
    active: v.boolean(),
    externalId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_code", ["code"]),
  inventoryBalances: defineTable({
    productCode: v.string(),
    warehouseCode: v.string(),
    onHand: v.number(),
    reserved: v.number(),
    available: v.number(),
    asOf: v.number(),
  })
    .index("by_product_warehouse", ["productCode", "warehouseCode"])
    .index("by_warehouse", ["warehouseCode"]),
  salesAssignments: defineTable({
    salespersonSubject: v.string(),
    customerCode: v.string(),
    territory: v.string(),
    active: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_salesperson", ["salespersonSubject"])
    .index("by_customer", ["customerCode"]),
  visits: defineTable({
    salespersonSubject: v.string(),
    customerCode: v.string(),
    scheduledAt: v.number(),
    completedAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    status: v.union(
      v.literal("planned"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
  })
    .index("by_salesperson_time", ["salespersonSubject", "scheduledAt"])
    .index("by_customer", ["customerCode"]),
  orders: defineTable({
    clientRequestId: v.string(),
    orderNumber: v.string(),
    customerCode: v.string(),
    salespersonSubject: v.string(),
    status: orderStatus,
    subtotal: v.number(),
    total: v.number(),
    offlineCreatedAt: v.optional(v.number()),
    sapDocumentNumber: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_client_request", ["clientRequestId"])
    .index("by_status", ["status"])
    .index("by_customer", ["customerCode"])
    .index("by_created_at", ["createdAt"]),
  orderLines: defineTable({
    orderId: v.id("orders"),
    productCode: v.string(),
    description: v.string(),
    quantity: v.number(),
    unitPrice: v.number(),
    lineTotal: v.number(),
  }).index("by_order", ["orderId"]),
  workflowInstances: defineTable({
    entityType: v.string(),
    entityId: v.string(),
    workflowType: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    currentStep: v.number(),
    requestedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_entity", ["entityType", "entityId"])
    .index("by_status", ["status"]),
  approvals: defineTable({
    workflowId: v.id("workflowInstances"),
    approverSubject: v.optional(v.string()),
    decision: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    comment: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
  })
    .index("by_workflow", ["workflowId"])
    .index("by_approver", ["approverSubject"]),
  integrationEvents: defineTable({
    eventId: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    eventType: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("dead_letter"),
    ),
    attempts: v.number(),
    payload: v.any(),
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_event_id", ["eventId"])
    .index("by_direction_status", ["direction", "status"])
    .index("by_status", ["status"]),
  connectorHeartbeats: defineTable({
    connectorId: v.string(),
    status: v.union(
      v.literal("online"),
      v.literal("degraded"),
      v.literal("offline"),
    ),
    adapter: v.string(),
    lastSeenAt: v.number(),
    details: v.optional(v.string()),
  }).index("by_connector", ["connectorId"]),
  auditLogs: defineTable({
    subject: v.string(),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    details: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_entity", ["entityType", "entityId"])
    .index("by_created_at", ["createdAt"]),
  metrics: defineTable({
    key: v.string(),
    productCount: v.number(),
    customerCount: v.number(),
    lowStockCount: v.number(),
    openOrderCount: v.number(),
    pendingApprovalCount: v.number(),
    salesToday: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
