// @ts-check
/**
 * Canonical inventory: locations, lots, movements, ledger, documents. Row shapes for migration 0107_inventory.sql.
 * Tables: inventory_locations, product_inventory_policies, replenishment_policies, inventory_movements, inventory_balances, inventory_lots, inventory_lot_balances, inventory_commands, inventory_movement_lines, inventory_allocations, inventory_ledger_entries, inventory_reservations, inventory_reservation_lines, goods_receipts, goods_receipt_lines, truck_route_sessions, stock_transfers, stock_transfer_lines, stock_count_sessions, stock_count_lines, inventory_adjustments, inventory_adjustment_lines, bill_of_materials, bill_of_material_versions, bill_of_material_components, production_orders, production_material_issues, production_output_receipts, lot_genealogy_links, truck_inventory_checkpoints, truck_inventory_checkpoint_lines, negative_stock_allowances, negative_stock_flags, inventory_reconciliation_runs, inventory_reconciliation_differences.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const INVENTORY_LOCATION_TYPE = /** @type {const} */ (["warehouse", "zone", "bin", "production", "wip", "truck", "in_transit", "returns", "virtual_boundary"]);
export const PRODUCT_INVENTORY_POLICY_TRACKING_MODE = /** @type {const} */ (["none", "lot", "serial"]);
export const PRODUCT_INVENTORY_POLICY_ALLOCATION_POLICY = /** @type {const} */ (["fefo", "fifo", "explicit_only"]);
export const PRODUCT_INVENTORY_POLICY_COSTING_METHOD = /** @type {const} */ (["weighted_average", "fifo_layer"]);
export const REPLENISHMENT_POLICY_LAST_ALERT_STATE = /** @type {const} */ (["ok", "low"]);
export const INVENTORY_MOVEMENT_MOVEMENT_TYPE = /** @type {const} */ (["opening_balance", "goods_receipt", "inventory_issue", "reservation", "reservation_release", "transfer_ship", "transfer_receive", "inventory_adjustment", "status_change", "pos_sale", "pos_void", "pos_return", "production_issue", "production_output", "production_scrap", "reversal", "van_load", "van_unload"]);
export const INVENTORY_MOVEMENT_STATUS = /** @type {const} */ (["posted", "reversed"]);
export const INVENTORY_LOT_QUALITY_STATUS = /** @type {const} */ (["pending", "released", "quarantined", "rejected", "expired"]);
export const INVENTORY_LOT_BALANCE_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const INVENTORY_COMMAND_STATUS = /** @type {const} */ (["posted", "rejected", "review_required"]);
export const INVENTORY_MOVEMENT_LINE_FROM_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const INVENTORY_MOVEMENT_LINE_TO_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const INVENTORY_ALLOCATION_FROM_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const INVENTORY_ALLOCATION_TO_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const INVENTORY_ALLOCATION_ALLOCATION_POLICY = /** @type {const} */ (["fefo", "fifo", "explicit_only"]);
export const INVENTORY_LEDGER_ENTRY_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const INVENTORY_RESERVATION_STATUS = /** @type {const} */ (["active", "partially_consumed", "consumed", "released", "expired", "cancelled"]);
export const GOODS_RECEIPT_RECEIPT_TYPE = /** @type {const} */ (["purchase_order", "transfer", "return", "production", "unplanned"]);
export const GOODS_RECEIPT_STATUS = /** @type {const} */ (["draft", "in_inspection", "partially_posted", "posted", "cancelled", "review_required"]);
export const GOODS_RECEIPT_LINE_DESTINATION_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const TRUCK_ROUTE_SESSION_STATUS = /** @type {const} */ (["planned", "loading", "open", "closing", "reconciling", "closed", "review_required"]);
export const STOCK_TRANSFER_STATUS = /** @type {const} */ (["draft", "requested", "approved", "reserved", "picking", "shipped", "partially_received", "received", "cancelled", "review_required"]);
export const STOCK_COUNT_SESSION_COUNT_TYPE = /** @type {const} */ (["cycle", "full", "spot", "route_close"]);
export const STOCK_COUNT_SESSION_STATUS = /** @type {const} */ (["draft", "frozen", "counting", "submitted", "reviewed", "approved", "posted", "cancelled"]);
export const STOCK_COUNT_LINE_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const STOCK_COUNT_LINE_FINDING = /** @type {const} */ (["over", "missing", "damaged", "expired", "wrong_lot", "wrong_location"]);
export const INVENTORY_ADJUSTMENT_STATUS = /** @type {const} */ (["draft", "submitted", "approved", "posted", "rejected", "reversed"]);
export const INVENTORY_ADJUSTMENT_LINE_STOCK_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const BILL_OF_MATERIAL_VERSION_STATUS = /** @type {const} */ (["draft", "approved", "active", "obsolete"]);
export const BILL_OF_MATERIAL_COMPONENT_ISSUE_POLICY = /** @type {const} */ (["backflush", "manual_issue", "staged"]);
export const PRODUCTION_ORDER_STATUS = /** @type {const} */ (["draft", "released", "material_staged", "in_progress", "partially_completed", "completed", "cancelled", "closed", "review_required"]);
export const PRODUCTION_MATERIAL_ISSUE_ISSUE_TYPE = /** @type {const} */ (["issue", "return"]);
export const PRODUCTION_OUTPUT_RECEIPT_QUALITY_STATUS = /** @type {const} */ (["available", "quality_hold", "quarantine", "damaged", "expired", "rejected", "wip", "in_transit"]);
export const NEGATIVE_STOCK_ALLOWANCE_OPERATION = /** @type {const} */ (["distributor"]);
export const NEGATIVE_STOCK_ALLOWANCE_MOVEMENT_TYPE = /** @type {const} */ (["pos_sale", "inventory_issue", "transfer_ship"]);
export const NEGATIVE_STOCK_FLAG_MOVEMENT_TYPE = /** @type {const} */ (["pos_sale", "inventory_issue", "transfer_ship"]);
export const NEGATIVE_STOCK_FLAG_STATUS = /** @type {const} */ (["open", "resolved"]);
export const INVENTORY_RECONCILIATION_RUN_STATUS = /** @type {const} */ (["pending", "running", "completed", "failed"]);
export const INVENTORY_RECONCILIATION_DIFFERENCE_CLASSIFICATION = /** @type {const} */ (["mapping", "timing", "missing_inbound", "missing_outbound", "duplicate", "unauthorized_adjustment", "unresolved"]);
export const INVENTORY_RECONCILIATION_DIFFERENCE_RESOLUTION_STATUS = /** @type {const} */ (["open", "resolved", "accepted"]);

/**
 * `inventory_locations` (Convex `inventoryLocations`)
 * @typedef {Object} InventoryLocationRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string | null} orgUnitId
 * @property {string} siteCode
 * @property {string | null} warehouseId
 * @property {string | null} parentLocationId
 * @property {string} code
 * @property {string} name
 * @property {"warehouse" | "zone" | "bin" | "production" | "wip" | "truck" | "in_transit" | "returns" | "virtual_boundary"} type
 * @property {boolean} active
 * @property {boolean} allowsPicking
 * @property {boolean} allowsReceiving
 * @property {boolean} allowsSale
 * @property {boolean} allowsProduction
 * @property {string | null} externalId
 * @property {string | null} truckCode
 * @property {string | null} assignedDeviceId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `product_inventory_policies` (Convex `productInventoryPolicies`)
 * @typedef {Object} ProductInventoryPolicyRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productId
 * @property {string} baseUomId
 * @property {string} quantityScale
 * @property {number} quantityPrecision
 * @property {"none" | "lot" | "serial"} trackingMode
 * @property {"fefo" | "fifo" | "explicit_only"} allocationPolicy
 * @property {boolean} allowMixedLotsPerLine
 * @property {boolean} allowNegativeStock
 * @property {boolean} qualityReleaseRequired
 * @property {number | null} shelfLifeDays
 * @property {boolean} expiryDateRequired
 * @property {boolean} manufactureDateRequired
 * @property {number} minimumRemainingShelfLifeDays
 * @property {"weighted_average" | "fifo_layer"} costingMethod
 * @property {number} version
 * @property {boolean} active
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `replenishment_policies` (Convex `replenishmentPolicies`)
 * @typedef {Object} ReplenishmentPolicyRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productId
 * @property {string | null} locationId
 * @property {boolean} enabled
 * @property {string} reorderPointBase
 * @property {string} targetLevelBase
 * @property {string} safetyStockBase
 * @property {number | null} leadTimeDays
 * @property {string} alertCooldownMs
 * @property {"ok" | "low" | null} lastAlertState
 * @property {Date | null} lastAlertedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_movements` (Convex `inventoryMovements`)
 * @typedef {Object} InventoryMovementRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} movementNumber
 * @property {"opening_balance" | "goods_receipt" | "inventory_issue" | "reservation" | "reservation_release" | "transfer_ship" | "transfer_receive" | "inventory_adjustment" | "status_change" | "pos_sale" | "pos_void" | "pos_return" | "production_issue" | "production_output" | "production_scrap" | "reversal" | "van_load" | "van_unload"} movementType
 * @property {string} sourceType
 * @property {string | null} sourceDocumentId
 * @property {"posted" | "reversed"} status
 * @property {Date} effectiveAt
 * @property {Date} postedAt
 * @property {string} postedBy
 * @property {string | null} deviceId
 * @property {string} idempotencyKey
 * @property {string | null} reasonCode
 * @property {string | null} note
 * @property {string | null} reversesMovementId
 * @property {string | null} reversedByMovementId
 * @property {number} schemaVersion
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_balances` (Convex `inventoryBalances`)
 * @typedef {Object} InventoryBalanceRow
 * @property {string} id
 * @property {string} productCode
 * @property {string} warehouseCode
 * @property {string} onHand
 * @property {string} reserved
 * @property {string} available
 * @property {Date} asOf
 * @property {string | null} organizationId
 * @property {string | null} productId
 * @property {string | null} locationId
 * @property {string | null} physicalBase
 * @property {string | null} availableStockBase
 * @property {string | null} reservedBase
 * @property {string | null} availableBase
 * @property {string | null} qualityHoldBase
 * @property {string | null} quarantineBase
 * @property {string | null} damagedBase
 * @property {string | null} expiredBase
 * @property {string | null} rejectedBase
 * @property {string | null} wipBase
 * @property {string | null} inTransitBase
 * @property {string | null} weightedAverageCostMinor
 * @property {string | null} inventoryValueMinor
 * @property {number | null} version
 * @property {string | null} lastMovementId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `inventory_lots` (Convex `inventoryLots`)
 * @typedef {Object} InventoryLotRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productId
 * @property {string} lotNumber
 * @property {string} normalizedLotNumber
 * @property {string | null} supplierLotNumber
 * @property {string} sourceType
 * @property {string | null} sourceDocumentId
 * @property {string | null} sourceLineId
 * @property {Date | null} manufacturedAt
 * @property {Date} receivedAt
 * @property {Date | null} expiresAt
 * @property {"pending" | "released" | "quarantined" | "rejected" | "expired"} qualityStatus
 * @property {string | null} unitCostMinor
 * @property {Date | null} closedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_lot_balances` (Convex `inventoryLotBalances`)
 * @typedef {Object} InventoryLotBalanceRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productId
 * @property {string} lotId
 * @property {string} locationId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit"} stockStatus
 * @property {string} physicalBase
 * @property {string} reservedBase
 * @property {string} availableBase
 * @property {string} expirySortKey
 * @property {string} receiptSequence
 * @property {number} version
 * @property {string | null} lastMovementId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_commands` (Convex `inventoryCommands`)
 * @typedef {Object} InventoryCommandRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} idempotencyKey
 * @property {string} commandType
 * @property {number} schemaVersion
 * @property {string} payloadHash
 * @property {string} actorSubject
 * @property {string | null} deviceId
 * @property {"posted" | "rejected" | "review_required"} status
 * @property {string | null} sourceDocumentId
 * @property {string | null} movementId
 * @property {unknown | null} result
 * @property {string | null} errorCode
 * @property {Date | null} committedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_movement_lines` (Convex `inventoryMovementLines`)
 * @typedef {Object} InventoryMovementLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} movementId
 * @property {number} lineNumber
 * @property {string} productId
 * @property {string | null} baseUomId
 * @property {string} quantityBase
 * @property {string | null} enteredQuantity
 * @property {string | null} enteredUomCode
 * @property {string | null} fromLocationId
 * @property {string | null} toLocationId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit" | null} fromStockStatus
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit" | null} toStockStatus
 * @property {string | null} sourceLineId
 * @property {string | null} unitCostMinor
 * @property {string | null} totalCostMinor
 * @property {string | null} reasonCode
 * @property {Date} effectiveAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_allocations` (Convex `inventoryAllocations`)
 * @typedef {Object} InventoryAllocationRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} movementId
 * @property {string} movementLineId
 * @property {string} productId
 * @property {string} lotId
 * @property {string} quantityBase
 * @property {string | null} fromLocationId
 * @property {string | null} toLocationId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit" | null} fromStockStatus
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit" | null} toStockStatus
 * @property {number} allocationSequence
 * @property {"fefo" | "fifo" | "explicit_only"} allocationPolicy
 * @property {boolean} userSelected
 * @property {string | null} reversesAllocationId
 * @property {Date} effectiveAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_ledger_entries` (Convex `inventoryLedgerEntries`)
 * @typedef {Object} InventoryLedgerEntryRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} movementId
 * @property {string} movementLineId
 * @property {string | null} allocationId
 * @property {string} productId
 * @property {string | null} lotId
 * @property {string} locationId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit"} stockStatus
 * @property {string} quantityDeltaBase
 * @property {string} reservedDeltaBase
 * @property {string | null} valueDeltaMinor
 * @property {number} balanceVersion
 * @property {string} quantityBeforeBase
 * @property {string} quantityAfterBase
 * @property {Date} effectiveAt
 * @property {Date} postedAt
 * @property {string | null} reversesEntryId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_reservations` (Convex `inventoryReservations`)
 * @typedef {Object} InventoryReservationRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} reservationNumber
 * @property {string} reservationType
 * @property {string} sourceType
 * @property {string} sourceDocumentId
 * @property {"active" | "partially_consumed" | "consumed" | "released" | "expired" | "cancelled"} status
 * @property {Date | null} expiresAt
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_reservation_lines` (Convex `inventoryReservationLines`)
 * @typedef {Object} InventoryReservationLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} reservationId
 * @property {string} productId
 * @property {string} locationId
 * @property {string | null} lotId
 * @property {string} requestedBase
 * @property {string} reservedBase
 * @property {string} consumedBase
 * @property {string} releasedBase
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `goods_receipts` (Convex `goodsReceipts`)
 * @typedef {Object} GoodsReceiptRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} receiptNumber
 * @property {"purchase_order" | "transfer" | "return" | "production" | "unplanned"} receiptType
 * @property {string | null} sourceDocumentId
 * @property {string} receivingLocationId
 * @property {"draft" | "in_inspection" | "partially_posted" | "posted" | "cancelled" | "review_required"} status
 * @property {string | null} deliveryReference
 * @property {string} receivedBy
 * @property {string | null} movementId
 * @property {string | null} note
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `goods_receipt_lines` (Convex `goodsReceiptLines`)
 * @typedef {Object} GoodsReceiptLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} receiptId
 * @property {string | null} sourceLineId
 * @property {string} productId
 * @property {string} acceptedBase
 * @property {string} rejectedBase
 * @property {string | null} lotId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit"} destinationStatus
 * @property {string | null} unitCostMinor
 * @property {string | null} movementLineId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `truck_route_sessions` (Convex `truckRouteSessions`)
 * @typedef {Object} TruckRouteSessionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} routeCode
 * @property {string} truckLocationId
 * @property {string} salespersonSubject
 * @property {string} assignedDeviceId
 * @property {"planned" | "loading" | "open" | "closing" | "reconciling" | "closed" | "review_required"} status
 * @property {Date | null} openedAt
 * @property {Date | null} closedAt
 * @property {string} lastAcknowledgedSequence
 * @property {Date | null} leaseExpiresAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `stock_transfers` (Convex `stockTransfers`)
 * @typedef {Object} StockTransferRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} transferNumber
 * @property {string} sourceLocationId
 * @property {string} destinationLocationId
 * @property {string} inTransitLocationId
 * @property {"draft" | "requested" | "approved" | "reserved" | "picking" | "shipped" | "partially_received" | "received" | "cancelled" | "review_required"} status
 * @property {string} requestedBy
 * @property {string | null} approvedBy
 * @property {string | null} shippedBy
 * @property {string | null} receivedBy
 * @property {string | null} routeSessionId
 * @property {string | null} outboundMovementId
 * @property {string | null} receiptMovementId
 * @property {string | null} note
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `stock_transfer_lines` (Convex `stockTransferLines`)
 * @typedef {Object} StockTransferLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} transferId
 * @property {string} productId
 * @property {string} requestedBase
 * @property {string} approvedBase
 * @property {string} shippedBase
 * @property {string} receivedBase
 * @property {string} rejectedBase
 * @property {string} shortBase
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `stock_count_sessions` (Convex `stockCountSessions`)
 * @typedef {Object} StockCountSessionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} countNumber
 * @property {"cycle" | "full" | "spot" | "route_close"} countType
 * @property {string} locationId
 * @property {"draft" | "frozen" | "counting" | "submitted" | "reviewed" | "approved" | "posted" | "cancelled"} status
 * @property {boolean} blindCount
 * @property {Date} snapshotAt
 * @property {string} createdBy
 * @property {string | null} approvedBy
 * @property {string | null} adjustmentId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `stock_count_lines` (Convex `stockCountLines`)
 * @typedef {Object} StockCountLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} sessionId
 * @property {string} productId
 * @property {string | null} lotId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit"} stockStatus
 * @property {string} systemBase
 * @property {number | null} snapshotBalanceVersion
 * @property {string | null} snapshotMovementId
 * @property {string | null} countedBase
 * @property {string | null} varianceBase
 * @property {"over" | "missing" | "damaged" | "expired" | "wrong_lot" | "wrong_location" | null} finding
 * @property {string | null} note
 * @property {string | null} countedBy
 * @property {Date | null} countedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_adjustments` (Convex `inventoryAdjustments`)
 * @typedef {Object} InventoryAdjustmentRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} adjustmentNumber
 * @property {string} adjustmentType
 * @property {string} reasonCode
 * @property {string | null} sourceCountId
 * @property {"draft" | "submitted" | "approved" | "posted" | "rejected" | "reversed"} status
 * @property {string} requestedBy
 * @property {string | null} approvedBy
 * @property {string | null} movementId
 * @property {string | null} note
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_adjustment_lines` (Convex `inventoryAdjustmentLines`)
 * @typedef {Object} InventoryAdjustmentLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} adjustmentId
 * @property {string} productId
 * @property {string | null} lotId
 * @property {string} locationId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit"} stockStatus
 * @property {string} varianceBase
 * @property {string | null} unitCostMinor
 * @property {string} reasonCode
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `bill_of_materials` (Convex `billOfMaterials`)
 * @typedef {Object} BillOfMaterialRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productId
 * @property {string} code
 * @property {string} name
 * @property {boolean} active
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `bill_of_material_versions` (Convex `billOfMaterialVersions`)
 * @typedef {Object} BillOfMaterialVersionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} bomId
 * @property {number} version
 * @property {string} outputQuantityBase
 * @property {"draft" | "approved" | "active" | "obsolete"} status
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {number} yieldTargetBps
 * @property {string | null} createdBy
 * @property {string | null} approvedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `bill_of_material_components` (Convex `billOfMaterialComponents`)
 * @typedef {Object} BillOfMaterialComponentRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} bomVersionId
 * @property {string} componentProductId
 * @property {string} quantityBase
 * @property {"backflush" | "manual_issue" | "staged"} issuePolicy
 * @property {number} scrapAllowanceBps
 * @property {boolean} optional
 * @property {string | null} preferredLocationId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `production_orders` (Convex `productionOrders`)
 * @typedef {Object} ProductionOrderRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productionOrderNumber
 * @property {string} productId
 * @property {string} bomVersionId
 * @property {string} plannedBase
 * @property {string} completedBase
 * @property {string} scrappedBase
 * @property {string} sourceLocationId
 * @property {string} wipLocationId
 * @property {string} outputLocationId
 * @property {"draft" | "released" | "material_staged" | "in_progress" | "partially_completed" | "completed" | "cancelled" | "closed" | "review_required"} status
 * @property {string} createdBy
 * @property {string | null} releasedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `production_material_issues` (Convex `productionMaterialIssues`)
 * @typedef {Object} ProductionMaterialIssueRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productionOrderId
 * @property {string} movementId
 * @property {"issue" | "return"} issueType
 * @property {string} postedBy
 * @property {Date} postedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `production_output_receipts` (Convex `productionOutputReceipts`)
 * @typedef {Object} ProductionOutputReceiptRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productionOrderId
 * @property {string} outputLotId
 * @property {string} quantityBase
 * @property {string} movementId
 * @property {"available" | "quality_hold" | "quarantine" | "damaged" | "expired" | "rejected" | "wip" | "in_transit"} qualityStatus
 * @property {string} postedBy
 * @property {Date} postedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `lot_genealogy_links` (Convex `lotGenealogyLinks`)
 * @typedef {Object} LotGenealogyLinkRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productionOrderId
 * @property {string} outputLotId
 * @property {string} componentLotId
 * @property {string} componentProductId
 * @property {string} quantityBase
 * @property {string} movementId
 * @property {string} movementLineId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `truck_inventory_checkpoints` (Convex `truckInventoryCheckpoints`)
 * @typedef {Object} TruckInventoryCheckpointRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} routeSessionId
 * @property {number} checkpointNumber
 * @property {string} serverSequence
 * @property {string} checksum
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `truck_inventory_checkpoint_lines` (Convex `truckInventoryCheckpointLines`)
 * @typedef {Object} TruckInventoryCheckpointLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} checkpointId
 * @property {string} productId
 * @property {string | null} lotId
 * @property {string} quantityBase
 * @property {number} balanceVersion
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `negative_stock_allowances` (Convex `negativeStockAllowances`)
 * @typedef {Object} NegativeStockAllowanceRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} locationId
 * @property {"distributor"} operation
 * @property {Array<"pos_sale" | "inventory_issue" | "transfer_ship">} movementTypes
 * @property {string | null} limitBase
 * @property {boolean} active
 * @property {string} sourceRef
 * @property {number} version
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `negative_stock_flags` (Convex `negativeStockFlags`)
 * @typedef {Object} NegativeStockFlagRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} allowanceId
 * @property {string} movementId
 * @property {"pos_sale" | "inventory_issue" | "transfer_ship"} movementType
 * @property {string} productId
 * @property {string} locationId
 * @property {string} quantityBase
 * @property {string} balanceAfterBase
 * @property {string} shortfallBase
 * @property {"open" | "resolved"} status
 * @property {string} postedBy
 * @property {string | null} resolvedBy
 * @property {Date | null} resolvedAt
 * @property {string | null} resolutionNote
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_reconciliation_runs` (Convex `inventoryReconciliationRuns`)
 * @typedef {Object} InventoryReconciliationRunRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} scope
 * @property {"pending" | "running" | "completed" | "failed"} status
 * @property {Date} convexCutoff
 * @property {Date} sapCutoff
 * @property {number} comparedCount
 * @property {number} differenceCount
 * @property {string} startedBy
 * @property {Date} startedAt
 * @property {Date | null} completedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `inventory_reconciliation_differences` (Convex `inventoryReconciliationDifferences`)
 * @typedef {Object} InventoryReconciliationDifferenceRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} runId
 * @property {string | null} productId
 * @property {string | null} locationId
 * @property {string} productCode
 * @property {string} warehouseCode
 * @property {string} convexBase
 * @property {string} sapBase
 * @property {string} differenceBase
 * @property {"mapping" | "timing" | "missing_inbound" | "missing_outbound" | "duplicate" | "unauthorized_adjustment" | "unresolved"} classification
 * @property {"open" | "resolved" | "accepted"} resolutionStatus
 * @property {string | null} note
 * @property {Date | null} resolvedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
