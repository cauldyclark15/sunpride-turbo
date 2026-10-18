// @ts-check
/**
 * Price lists, promotions, orders, workflows. Row shapes for migration 0109_pricing_orders.sql.
 * Tables: price_lists, price_list_lines, promotions, field_order_pricings, field_order_pricing_lines, orders, order_lines, outside_call_orders, outside_call_order_lines, visits, workflow_instances, approvals, metrics.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const PRICE_LIST_STATUS = /** @type {const} */ (["active", "inactive"]);
export const PRICE_LIST_SOURCE = /** @type {const} */ (["sample", "office"]);
export const PROMOTION_RULE_KIND = /** @type {const} */ (["buy_x_get_y", "percent_off", "bundle"]);
export const PROMOTION_STATUS = /** @type {const} */ (["active", "inactive"]);
export const PROMOTION_SOURCE = /** @type {const} */ (["sample", "office"]);
export const FIELD_ORDER_PRICING_PRICE_LIST_SOURCE = /** @type {const} */ (["sample", "office"]);
export const FIELD_ORDER_PRICING_CREDIT_STATUS = /** @type {const} */ (["within", "over", "no_limit", "unknown"]);
export const ORDER_STATUS = /** @type {const} */ (["draft", "submitted", "pending_approval", "approved", "rejected", "sent_to_sap", "fulfilled", "posted", "partially_voided", "voided", "returned", "review_required"]);
export const OUTSIDE_CALL_ORDER_RECEIVED_VIA = /** @type {const} */ (["email", "viber", "phone", "fax", "other"]);
export const OUTSIDE_CALL_ORDER_STATUS = /** @type {const} */ (["awaiting_activity", "activity_recorded", "cancelled"]);
export const OUTSIDE_CALL_ORDER_ACTIVITY_CONTACT = /** @type {const} */ (["phone", "message", "in_person", "other"]);
export const VISIT_STATUS = /** @type {const} */ (["planned", "completed", "cancelled"]);
export const WORKFLOW_INSTANCE_STATUS = /** @type {const} */ (["pending", "approved", "rejected"]);
export const APPROVAL_DECISION = /** @type {const} */ (["pending", "approved", "rejected"]);

/**
 * `price_lists` (Convex `priceLists`)
 * @typedef {Object} PriceListRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} name
 * @property {string | null} channelKey
 * @property {string} currency
 * @property {"active" | "inactive"} status
 * @property {"sample" | "office"} source
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `price_list_lines` (Convex `priceListLines`)
 * @typedef {Object} PriceListLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} priceListId
 * @property {string} productId
 * @property {string} uom
 * @property {string} unitPriceMinor
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `promotions` (Convex `promotions`)
 * @typedef {Object} PromotionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} name
 * @property {string | null} priceListId
 * @property {"buy_x_get_y" | "percent_off" | "bundle"} ruleKind
 * @property {Record<string, unknown>} rule
 * @property {"active" | "inactive"} status
 * @property {"sample" | "office"} source
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `field_order_pricings` (Convex `fieldOrderPricings`)
 * @typedef {Object} FieldOrderPricingRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} visitId
 * @property {string} activityId
 * @property {string} outletId
 * @property {string | null} customerId
 * @property {string} clientOrderId
 * @property {string | null} priceListId
 * @property {"sample" | "office" | null} priceListSource
 * @property {string} currency
 * @property {Date} pricedAt
 * @property {string} totalMinor
 * @property {number} unpricedLines
 * @property {"within" | "over" | "no_limit" | "unknown"} creditStatus
 * @property {string | null} creditLimitMinor
 * @property {string | null} creditOpenOrdersMinor
 * @property {Date} serverTime
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `field_order_pricing_lines` (Convex `fieldOrderPricings`, child of `field_order_pricings`)
 * @typedef {Object} FieldOrderPricingLineRow
 * @property {string} id
 * @property {string} fieldOrderPricingId
 * @property {number} ordinal
 * @property {string} productId
 * @property {string} uom
 * @property {string} quantity
 * @property {string | null} unitPriceMinor
 * @property {string | null} lineTotalMinor
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `orders` (Convex `orders`)
 * @typedef {Object} OrderRow
 * @property {string} id
 * @property {string | null} organizationId
 * @property {string} clientRequestId
 * @property {string} orderNumber
 * @property {string | null} orderType
 * @property {string} customerCode
 * @property {string} salespersonSubject
 * @property {"draft" | "submitted" | "pending_approval" | "approved" | "rejected" | "sent_to_sap" | "fulfilled" | "posted" | "partially_voided" | "voided" | "returned" | "review_required"} status
 * @property {string} subtotal
 * @property {string} total
 * @property {Date | null} offlineCreatedAt
 * @property {string | null} sapDocumentNumber
 * @property {string | null} sourceLocationId
 * @property {string | null} routeSessionId
 * @property {string | null} deviceId
 * @property {string | null} inventoryMovementId
 * @property {string | null} requestPayloadHash
 * @property {string | null} deviceSequence
 * @property {string | null} voidMovementId
 * @property {string | null} originalOrderId
 * @property {Date | null} voidedAt
 * @property {string | null} voidedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `order_lines` (Convex `orderLines`)
 * @typedef {Object} OrderLineRow
 * @property {string} id
 * @property {string} orderId
 * @property {string} productCode
 * @property {string} description
 * @property {string} quantity
 * @property {string} unitPrice
 * @property {string} lineTotal
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outside_call_orders` (Convex `outsideCallOrders`)
 * @typedef {Object} OutsideCallOrderRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} outletId
 * @property {string} territoryId
 * @property {string | null} customerId
 * @property {string} salespersonProfileId
 * @property {Date} serviceDate
 * @property {string} poNumber
 * @property {"email" | "viber" | "phone" | "fax" | "other"} receivedVia
 * @property {string | null} note
 * @property {"awaiting_activity" | "activity_recorded" | "cancelled"} status
 * @property {string} clientRequestId
 * @property {string} encodedBy
 * @property {string} encodedByProfileId
 * @property {Date} encodedAt
 * @property {"phone" | "message" | "in_person" | "other" | null} activityContact
 * @property {string[]} activityCodes
 * @property {string | null} activityNote
 * @property {Date | null} activityRecordedAt
 * @property {string | null} cancelledByProfileId
 * @property {Date | null} cancelledAt
 * @property {string | null} cancelReason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outside_call_order_lines` (Convex `outsideCallOrders`, child of `outside_call_orders`)
 * @typedef {Object} OutsideCallOrderLineRow
 * @property {string} id
 * @property {string} outsideCallOrderId
 * @property {number} ordinal
 * @property {string} productId
 * @property {string} productCode
 * @property {string} productName
 * @property {string} quantity
 * @property {string} uom
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `visits` (Convex `visits`)
 * @typedef {Object} VisitRow
 * @property {string} id
 * @property {string} salespersonSubject
 * @property {string} customerCode
 * @property {Date} scheduledAt
 * @property {Date | null} completedAt
 * @property {string | null} notes
 * @property {"planned" | "completed" | "cancelled"} status
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `workflow_instances` (Convex `workflowInstances`)
 * @typedef {Object} WorkflowInstanceRow
 * @property {string} id
 * @property {string} entityType
 * @property {string} entityId
 * @property {string} workflowType
 * @property {"pending" | "approved" | "rejected"} status
 * @property {number} currentStep
 * @property {string} requestedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `approvals` (Convex `approvals`)
 * @typedef {Object} ApprovalRow
 * @property {string} id
 * @property {string} workflowId
 * @property {string | null} approverSubject
 * @property {"pending" | "approved" | "rejected"} decision
 * @property {string | null} comment
 * @property {Date | null} decidedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `metrics` (Convex `metrics`)
 * @typedef {Object} MetricRow
 * @property {string} id
 * @property {string} key
 * @property {number} productCount
 * @property {number} customerCount
 * @property {number} lowStockCount
 * @property {number} openOrderCount
 * @property {number} pendingApprovalCount
 * @property {string} salesToday
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
