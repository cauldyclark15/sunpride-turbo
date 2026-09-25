import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  approvedOutletSnapshot,
  cycleType,
  frequency,
  planStatus,
  plannedVisitStatus,
  routineDayKind,
  slotKind,
  weekday,
} from "./coverage/validators";
import { employmentTypeValidator, roleValidator } from "./lib/roles";
import { positionCategoryValidator } from "./sfa/constants";
import {
  allocationPolicyValidator,
  approvalStatusValidator,
  commandStatusValidator,
  costingMethodValidator,
  locationTypeValidator,
  movementTypeValidator,
  productionStatusValidator,
  receiptStatusValidator,
  reservationStatusValidator,
  stockStatusValidator,
  trackingModeValidator,
  transferStatusValidator,
} from "./inventory/validators";

const role = roleValidator;
const orderStatus = v.union(
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
);

export default defineSchema({
  profiles: defineTable({
    authSubject: v.string(),
    name: v.string(),
    email: v.string(),
    role,
    status: v.union(v.literal("active"), v.literal("disabled")),
    orgUnitId: v.optional(v.id("orgUnits")),
    employeeCode: v.optional(v.string()),
    positionId: v.optional(v.id("positions")),
    employmentType: v.optional(employmentTypeValidator),
    channelScope: v.optional(v.string()),
    supervisorSubject: v.optional(v.string()),
    effectiveFrom: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_subject", ["authSubject"])
    .index("by_email", ["email"])
    .index("by_role", ["role"])
    .index("by_employeeCode", ["employeeCode"])
    .index("by_orgUnitId", ["orgUnitId"]),
  accessInvitations: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    role,
    positionId: v.optional(v.id("positions")),
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
    organizationId: v.optional(v.string()),
    baseUomId: v.optional(v.id("unitsOfMeasure")),
    quantityScale: v.optional(v.int64()),
    trackingMode: v.optional(trackingModeValidator),
    allocationPolicy: v.optional(allocationPolicyValidator),
    policyVersion: v.optional(v.number()),
    sellingUomIds: v.optional(v.array(v.id("unitsOfMeasure"))),
    catalogSource: v.optional(v.string()),
    catalogUpdatedAt: v.optional(v.number()),
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
    organizationId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_code", ["code"]),
  inventoryBalances: defineTable({
    productCode: v.string(),
    warehouseCode: v.string(),
    onHand: v.number(),
    reserved: v.number(),
    available: v.number(),
    asOf: v.number(),
    organizationId: v.optional(v.string()),
    productId: v.optional(v.id("products")),
    locationId: v.optional(v.id("inventoryLocations")),
    physicalBase: v.optional(v.int64()),
    availableStockBase: v.optional(v.int64()),
    reservedBase: v.optional(v.int64()),
    availableBase: v.optional(v.int64()),
    qualityHoldBase: v.optional(v.int64()),
    quarantineBase: v.optional(v.int64()),
    damagedBase: v.optional(v.int64()),
    expiredBase: v.optional(v.int64()),
    rejectedBase: v.optional(v.int64()),
    wipBase: v.optional(v.int64()),
    inTransitBase: v.optional(v.int64()),
    weightedAverageCostMinor: v.optional(v.int64()),
    inventoryValueMinor: v.optional(v.int64()),
    version: v.optional(v.number()),
    lastMovementId: v.optional(v.id("inventoryMovements")),
  })
    .index("by_product_warehouse", ["productCode", "warehouseCode"])
    .index("by_warehouse", ["warehouseCode"])
    .index("by_organizationId_and_productId_and_locationId", [
      "organizationId",
      "productId",
      "locationId",
    ])
    .index("by_organizationId_and_locationId_and_productId", [
      "organizationId",
      "locationId",
      "productId",
    ]),
  unitsOfMeasure: defineTable({
    organizationId: v.string(),
    code: v.string(),
    name: v.string(),
    dimension: v.union(
      v.literal("count"),
      v.literal("mass"),
      v.literal("volume"),
      v.literal("length"),
      v.literal("area"),
    ),
    decimalPlaces: v.number(),
    active: v.boolean(),
    externalCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_dimension_and_active", [
      "organizationId",
      "dimension",
      "active",
    ]),
  uomConversions: defineTable({
    organizationId: v.string(),
    productId: v.optional(v.id("products")),
    fromUomId: v.id("unitsOfMeasure"),
    toUomId: v.id("unitsOfMeasure"),
    numerator: v.int64(),
    denominator: v.int64(),
    roundingMode: v.union(
      v.literal("exact"),
      v.literal("half_up"),
      v.literal("floor"),
      v.literal("ceiling"),
    ),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_productId_and_fromUomId_and_toUomId", [
      "organizationId",
      "productId",
      "fromUomId",
      "toUomId",
    ])
    .index("by_organizationId_and_fromUomId_and_toUomId", [
      "organizationId",
      "fromUomId",
      "toUomId",
    ]),
  productInventoryPolicies: defineTable({
    organizationId: v.string(),
    productId: v.id("products"),
    baseUomId: v.id("unitsOfMeasure"),
    quantityScale: v.int64(),
    quantityPrecision: v.number(),
    trackingMode: trackingModeValidator,
    allocationPolicy: allocationPolicyValidator,
    allowMixedLotsPerLine: v.boolean(),
    allowNegativeStock: v.boolean(),
    qualityReleaseRequired: v.boolean(),
    shelfLifeDays: v.optional(v.number()),
    expiryDateRequired: v.boolean(),
    manufactureDateRequired: v.boolean(),
    minimumRemainingShelfLifeDays: v.number(),
    costingMethod: costingMethodValidator,
    version: v.number(),
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_productId", ["organizationId", "productId"])
    .index("by_organizationId_and_trackingMode_and_active", [
      "organizationId",
      "trackingMode",
      "active",
    ]),
  replenishmentPolicies: defineTable({
    organizationId: v.string(),
    productId: v.id("products"),
    locationId: v.optional(v.id("inventoryLocations")),
    enabled: v.boolean(),
    reorderPointBase: v.int64(),
    targetLevelBase: v.int64(),
    safetyStockBase: v.int64(),
    leadTimeDays: v.optional(v.number()),
    alertCooldownMs: v.number(),
    lastAlertState: v.optional(v.union(v.literal("ok"), v.literal("low"))),
    lastAlertedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_productId_and_locationId", [
      "organizationId",
      "productId",
      "locationId",
    ])
    .index("by_organizationId_and_enabled", ["organizationId", "enabled"]),
  inventoryLocations: defineTable({
    organizationId: v.string(),
    orgUnitId: v.optional(v.id("orgUnits")),
    siteCode: v.string(),
    warehouseId: v.optional(v.id("warehouses")),
    parentLocationId: v.optional(v.id("inventoryLocations")),
    code: v.string(),
    name: v.string(),
    type: locationTypeValidator,
    active: v.boolean(),
    allowsPicking: v.boolean(),
    allowsReceiving: v.boolean(),
    allowsSale: v.boolean(),
    allowsProduction: v.boolean(),
    externalId: v.optional(v.string()),
    truckCode: v.optional(v.string()),
    assignedDeviceId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgUnitId", ["orgUnitId"])
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_siteCode_and_type_and_active", [
      "organizationId",
      "siteCode",
      "type",
      "active",
    ])
    .index("by_organizationId_and_warehouseId_and_parentLocationId", [
      "organizationId",
      "warehouseId",
      "parentLocationId",
    ])
    .index("by_organizationId_and_truckCode", ["organizationId", "truckCode"]),
  inventoryLots: defineTable({
    organizationId: v.string(),
    productId: v.id("products"),
    lotNumber: v.string(),
    normalizedLotNumber: v.string(),
    supplierLotNumber: v.optional(v.string()),
    sourceType: v.string(),
    sourceDocumentId: v.optional(v.string()),
    sourceLineId: v.optional(v.string()),
    manufacturedAt: v.optional(v.number()),
    receivedAt: v.number(),
    expiresAt: v.optional(v.number()),
    qualityStatus: v.union(
      v.literal("pending"),
      v.literal("released"),
      v.literal("quarantined"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    unitCostMinor: v.optional(v.int64()),
    closedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_productId_and_normalizedLotNumber", [
      "organizationId",
      "productId",
      "normalizedLotNumber",
    ])
    .index("by_organizationId_and_productId_and_expiresAt", [
      "organizationId",
      "productId",
      "expiresAt",
    ])
    .index("by_organizationId_and_qualityStatus_and_expiresAt", [
      "organizationId",
      "qualityStatus",
      "expiresAt",
    ])
    .index("by_organizationId_and_sourceType_and_sourceDocumentId", [
      "organizationId",
      "sourceType",
      "sourceDocumentId",
    ]),
  inventoryLotBalances: defineTable({
    organizationId: v.string(),
    productId: v.id("products"),
    lotId: v.id("inventoryLots"),
    locationId: v.id("inventoryLocations"),
    stockStatus: stockStatusValidator,
    physicalBase: v.int64(),
    reservedBase: v.int64(),
    availableBase: v.int64(),
    expirySortKey: v.number(),
    receiptSequence: v.number(),
    version: v.number(),
    lastMovementId: v.optional(v.id("inventoryMovements")),
    updatedAt: v.number(),
  })
    .index("by_org_product_location_status_expiry", [
      "organizationId",
      "productId",
      "locationId",
      "stockStatus",
      "expirySortKey",
    ])
    .index("by_organizationId_and_lotId_and_locationId_and_stockStatus", [
      "organizationId",
      "lotId",
      "locationId",
      "stockStatus",
    ])
    .index("by_organizationId_and_lotId", ["organizationId", "lotId"])
    .index("by_organizationId_and_locationId_and_productId", [
      "organizationId",
      "locationId",
      "productId",
    ]),
  inventoryCommands: defineTable({
    organizationId: v.string(),
    idempotencyKey: v.string(),
    commandType: v.string(),
    schemaVersion: v.number(),
    payloadHash: v.string(),
    actorSubject: v.string(),
    deviceId: v.optional(v.string()),
    status: commandStatusValidator,
    sourceDocumentId: v.optional(v.string()),
    movementId: v.optional(v.id("inventoryMovements")),
    result: v.optional(v.any()),
    errorCode: v.optional(v.string()),
    createdAt: v.number(),
    committedAt: v.optional(v.number()),
  }).index("by_organizationId_and_idempotencyKey", [
    "organizationId",
    "idempotencyKey",
  ]),
  inventoryMovements: defineTable({
    organizationId: v.string(),
    movementNumber: v.string(),
    movementType: movementTypeValidator,
    sourceType: v.string(),
    sourceDocumentId: v.optional(v.string()),
    status: v.union(v.literal("posted"), v.literal("reversed")),
    effectiveAt: v.number(),
    postedAt: v.number(),
    postedBy: v.string(),
    deviceId: v.optional(v.string()),
    idempotencyKey: v.string(),
    reasonCode: v.optional(v.string()),
    note: v.optional(v.string()),
    reversesMovementId: v.optional(v.id("inventoryMovements")),
    reversedByMovementId: v.optional(v.id("inventoryMovements")),
    schemaVersion: v.number(),
  })
    .index("by_organizationId_and_movementNumber", [
      "organizationId",
      "movementNumber",
    ])
    .index("by_organizationId_and_sourceType_and_sourceDocumentId", [
      "organizationId",
      "sourceType",
      "sourceDocumentId",
    ])
    .index("by_organizationId_and_movementType_and_effectiveAt", [
      "organizationId",
      "movementType",
      "effectiveAt",
    ])
    .index("by_organizationId_and_postedAt", ["organizationId", "postedAt"])
    .index("by_organizationId_and_reversesMovementId", [
      "organizationId",
      "reversesMovementId",
    ]),
  inventoryMovementLines: defineTable({
    organizationId: v.string(),
    movementId: v.id("inventoryMovements"),
    lineNumber: v.number(),
    productId: v.id("products"),
    baseUomId: v.optional(v.id("unitsOfMeasure")),
    quantityBase: v.int64(),
    enteredQuantity: v.optional(v.string()),
    enteredUomCode: v.optional(v.string()),
    fromLocationId: v.optional(v.id("inventoryLocations")),
    toLocationId: v.optional(v.id("inventoryLocations")),
    fromStockStatus: v.optional(stockStatusValidator),
    toStockStatus: v.optional(stockStatusValidator),
    sourceLineId: v.optional(v.string()),
    unitCostMinor: v.optional(v.int64()),
    totalCostMinor: v.optional(v.int64()),
    reasonCode: v.optional(v.string()),
    effectiveAt: v.number(),
  })
    .index("by_organizationId_and_movementId_and_lineNumber", [
      "organizationId",
      "movementId",
      "lineNumber",
    ])
    .index("by_organizationId_and_productId_and_effectiveAt", [
      "organizationId",
      "productId",
      "effectiveAt",
    ])
    .index("by_organizationId_and_sourceLineId", [
      "organizationId",
      "sourceLineId",
    ]),
  inventoryAllocations: defineTable({
    organizationId: v.string(),
    movementId: v.id("inventoryMovements"),
    movementLineId: v.id("inventoryMovementLines"),
    productId: v.id("products"),
    lotId: v.id("inventoryLots"),
    quantityBase: v.int64(),
    fromLocationId: v.optional(v.id("inventoryLocations")),
    toLocationId: v.optional(v.id("inventoryLocations")),
    fromStockStatus: v.optional(stockStatusValidator),
    toStockStatus: v.optional(stockStatusValidator),
    allocationSequence: v.number(),
    allocationPolicy: allocationPolicyValidator,
    userSelected: v.boolean(),
    reversesAllocationId: v.optional(v.id("inventoryAllocations")),
    effectiveAt: v.number(),
  })
    .index("by_organizationId_and_movementLineId", [
      "organizationId",
      "movementLineId",
    ])
    .index("by_organizationId_and_lotId_and_effectiveAt", [
      "organizationId",
      "lotId",
      "effectiveAt",
    ])
    .index("by_organizationId_and_reversesAllocationId", [
      "organizationId",
      "reversesAllocationId",
    ]),
  inventoryLedgerEntries: defineTable({
    organizationId: v.string(),
    movementId: v.id("inventoryMovements"),
    movementLineId: v.id("inventoryMovementLines"),
    allocationId: v.optional(v.id("inventoryAllocations")),
    productId: v.id("products"),
    lotId: v.optional(v.id("inventoryLots")),
    locationId: v.id("inventoryLocations"),
    stockStatus: stockStatusValidator,
    quantityDeltaBase: v.int64(),
    reservedDeltaBase: v.int64(),
    valueDeltaMinor: v.optional(v.int64()),
    balanceVersion: v.number(),
    quantityBeforeBase: v.int64(),
    quantityAfterBase: v.int64(),
    effectiveAt: v.number(),
    postedAt: v.number(),
    reversesEntryId: v.optional(v.id("inventoryLedgerEntries")),
  })
    .index("by_organizationId_and_movementId", ["organizationId", "movementId"])
    .index("by_organizationId_and_productId_and_locationId_and_effectiveAt", [
      "organizationId",
      "productId",
      "locationId",
      "effectiveAt",
    ])
    .index("by_organizationId_and_lotId_and_locationId_and_effectiveAt", [
      "organizationId",
      "lotId",
      "locationId",
      "effectiveAt",
    ]),
  inventoryReservations: defineTable({
    organizationId: v.string(),
    reservationNumber: v.string(),
    reservationType: v.string(),
    sourceType: v.string(),
    sourceDocumentId: v.string(),
    status: reservationStatusValidator,
    expiresAt: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_sourceType_and_sourceDocumentId", [
      "organizationId",
      "sourceType",
      "sourceDocumentId",
    ])
    .index("by_organizationId_and_status_and_expiresAt", [
      "organizationId",
      "status",
      "expiresAt",
    ]),
  inventoryReservationLines: defineTable({
    organizationId: v.string(),
    reservationId: v.id("inventoryReservations"),
    productId: v.id("products"),
    locationId: v.id("inventoryLocations"),
    lotId: v.optional(v.id("inventoryLots")),
    requestedBase: v.int64(),
    reservedBase: v.int64(),
    consumedBase: v.int64(),
    releasedBase: v.int64(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_reservationId", [
      "organizationId",
      "reservationId",
    ])
    .index("by_organizationId_and_productId_and_locationId", [
      "organizationId",
      "productId",
      "locationId",
    ]),
  goodsReceipts: defineTable({
    organizationId: v.string(),
    receiptNumber: v.string(),
    receiptType: v.union(
      v.literal("purchase_order"),
      v.literal("transfer"),
      v.literal("return"),
      v.literal("production"),
      v.literal("unplanned"),
    ),
    sourceDocumentId: v.optional(v.string()),
    receivingLocationId: v.id("inventoryLocations"),
    status: receiptStatusValidator,
    deliveryReference: v.optional(v.string()),
    receivedBy: v.string(),
    movementId: v.optional(v.id("inventoryMovements")),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_receiptNumber", [
      "organizationId",
      "receiptNumber",
    ])
    .index("by_organizationId_and_status_and_createdAt", [
      "organizationId",
      "status",
      "createdAt",
    ])
    .index("by_organizationId_and_sourceDocumentId", [
      "organizationId",
      "sourceDocumentId",
    ]),
  goodsReceiptLines: defineTable({
    organizationId: v.string(),
    receiptId: v.id("goodsReceipts"),
    sourceLineId: v.optional(v.string()),
    productId: v.id("products"),
    acceptedBase: v.int64(),
    rejectedBase: v.int64(),
    lotId: v.optional(v.id("inventoryLots")),
    destinationStatus: stockStatusValidator,
    unitCostMinor: v.optional(v.int64()),
    movementLineId: v.optional(v.id("inventoryMovementLines")),
    createdAt: v.number(),
  })
    .index("by_organizationId_and_receiptId", ["organizationId", "receiptId"])
    .index("by_organizationId_and_sourceLineId", [
      "organizationId",
      "sourceLineId",
    ]),
  stockTransfers: defineTable({
    organizationId: v.string(),
    transferNumber: v.string(),
    sourceLocationId: v.id("inventoryLocations"),
    destinationLocationId: v.id("inventoryLocations"),
    inTransitLocationId: v.id("inventoryLocations"),
    status: transferStatusValidator,
    requestedBy: v.string(),
    approvedBy: v.optional(v.string()),
    shippedBy: v.optional(v.string()),
    receivedBy: v.optional(v.string()),
    routeSessionId: v.optional(v.id("truckRouteSessions")),
    outboundMovementId: v.optional(v.id("inventoryMovements")),
    receiptMovementId: v.optional(v.id("inventoryMovements")),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_transferNumber", [
      "organizationId",
      "transferNumber",
    ])
    .index("by_organizationId_and_status_and_createdAt", [
      "organizationId",
      "status",
      "createdAt",
    ])
    .index("by_organizationId_and_sourceLocationId_and_status", [
      "organizationId",
      "sourceLocationId",
      "status",
    ])
    .index("by_organizationId_and_destinationLocationId_and_status", [
      "organizationId",
      "destinationLocationId",
      "status",
    ]),
  stockTransferLines: defineTable({
    organizationId: v.string(),
    transferId: v.id("stockTransfers"),
    productId: v.id("products"),
    requestedBase: v.int64(),
    approvedBase: v.int64(),
    shippedBase: v.int64(),
    receivedBase: v.int64(),
    rejectedBase: v.int64(),
    shortBase: v.int64(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organizationId_and_transferId", [
    "organizationId",
    "transferId",
  ]),
  stockCountSessions: defineTable({
    organizationId: v.string(),
    countNumber: v.string(),
    countType: v.union(
      v.literal("cycle"),
      v.literal("full"),
      v.literal("spot"),
      v.literal("route_close"),
    ),
    locationId: v.id("inventoryLocations"),
    status: v.union(
      v.literal("draft"),
      v.literal("frozen"),
      v.literal("counting"),
      v.literal("submitted"),
      v.literal("reviewed"),
      v.literal("approved"),
      v.literal("posted"),
      v.literal("cancelled"),
    ),
    blindCount: v.boolean(),
    snapshotAt: v.number(),
    createdBy: v.string(),
    approvedBy: v.optional(v.string()),
    adjustmentId: v.optional(v.id("inventoryAdjustments")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_countNumber", [
      "organizationId",
      "countNumber",
    ])
    .index("by_organizationId_and_locationId_and_status", [
      "organizationId",
      "locationId",
      "status",
    ]),
  stockCountLines: defineTable({
    organizationId: v.string(),
    sessionId: v.id("stockCountSessions"),
    productId: v.id("products"),
    lotId: v.optional(v.id("inventoryLots")),
    stockStatus: stockStatusValidator,
    systemBase: v.int64(),
    snapshotBalanceVersion: v.optional(v.number()),
    snapshotMovementId: v.optional(v.id("inventoryMovements")),
    countedBase: v.optional(v.int64()),
    varianceBase: v.optional(v.int64()),
    finding: v.optional(
      v.union(
        v.literal("over"),
        v.literal("missing"),
        v.literal("damaged"),
        v.literal("expired"),
        v.literal("wrong_lot"),
        v.literal("wrong_location"),
      ),
    ),
    note: v.optional(v.string()),
    countedBy: v.optional(v.string()),
    countedAt: v.optional(v.number()),
  }).index("by_organizationId_and_sessionId", ["organizationId", "sessionId"]),
  inventoryAdjustments: defineTable({
    organizationId: v.string(),
    adjustmentNumber: v.string(),
    adjustmentType: v.string(),
    reasonCode: v.string(),
    sourceCountId: v.optional(v.id("stockCountSessions")),
    status: approvalStatusValidator,
    requestedBy: v.string(),
    approvedBy: v.optional(v.string()),
    movementId: v.optional(v.id("inventoryMovements")),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_adjustmentNumber", [
      "organizationId",
      "adjustmentNumber",
    ])
    .index("by_organizationId_and_status_and_createdAt", [
      "organizationId",
      "status",
      "createdAt",
    ]),
  inventoryAdjustmentLines: defineTable({
    organizationId: v.string(),
    adjustmentId: v.id("inventoryAdjustments"),
    productId: v.id("products"),
    lotId: v.optional(v.id("inventoryLots")),
    locationId: v.id("inventoryLocations"),
    stockStatus: stockStatusValidator,
    varianceBase: v.int64(),
    unitCostMinor: v.optional(v.int64()),
    reasonCode: v.string(),
  }).index("by_organizationId_and_adjustmentId", [
    "organizationId",
    "adjustmentId",
  ]),
  billOfMaterials: defineTable({
    organizationId: v.string(),
    productId: v.id("products"),
    code: v.string(),
    name: v.string(),
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_productId", ["organizationId", "productId"]),
  billOfMaterialVersions: defineTable({
    organizationId: v.string(),
    bomId: v.id("billOfMaterials"),
    version: v.number(),
    outputQuantityBase: v.int64(),
    status: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("active"),
      v.literal("obsolete"),
    ),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    yieldTargetBps: v.number(),
    createdBy: v.optional(v.string()),
    approvedBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organizationId_and_bomId_and_version", [
    "organizationId",
    "bomId",
    "version",
  ]),
  billOfMaterialComponents: defineTable({
    organizationId: v.string(),
    bomVersionId: v.id("billOfMaterialVersions"),
    componentProductId: v.id("products"),
    quantityBase: v.int64(),
    issuePolicy: v.union(
      v.literal("backflush"),
      v.literal("manual_issue"),
      v.literal("staged"),
    ),
    scrapAllowanceBps: v.number(),
    optional: v.boolean(),
    preferredLocationId: v.optional(v.id("inventoryLocations")),
    createdAt: v.number(),
  }).index("by_organizationId_and_bomVersionId", [
    "organizationId",
    "bomVersionId",
  ]),
  productionOrders: defineTable({
    organizationId: v.string(),
    productionOrderNumber: v.string(),
    productId: v.id("products"),
    bomVersionId: v.id("billOfMaterialVersions"),
    plannedBase: v.int64(),
    completedBase: v.int64(),
    scrappedBase: v.int64(),
    sourceLocationId: v.id("inventoryLocations"),
    wipLocationId: v.id("inventoryLocations"),
    outputLocationId: v.id("inventoryLocations"),
    status: productionStatusValidator,
    createdBy: v.string(),
    releasedBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_productionOrderNumber", [
      "organizationId",
      "productionOrderNumber",
    ])
    .index("by_organizationId_and_status_and_createdAt", [
      "organizationId",
      "status",
      "createdAt",
    ]),
  productionMaterialIssues: defineTable({
    organizationId: v.string(),
    productionOrderId: v.id("productionOrders"),
    movementId: v.id("inventoryMovements"),
    issueType: v.union(v.literal("issue"), v.literal("return")),
    postedBy: v.string(),
    postedAt: v.number(),
  }).index("by_organizationId_and_productionOrderId", [
    "organizationId",
    "productionOrderId",
  ]),
  productionOutputReceipts: defineTable({
    organizationId: v.string(),
    productionOrderId: v.id("productionOrders"),
    outputLotId: v.id("inventoryLots"),
    quantityBase: v.int64(),
    movementId: v.id("inventoryMovements"),
    qualityStatus: stockStatusValidator,
    postedBy: v.string(),
    postedAt: v.number(),
  }).index("by_organizationId_and_productionOrderId", [
    "organizationId",
    "productionOrderId",
  ]),
  lotGenealogyLinks: defineTable({
    organizationId: v.string(),
    productionOrderId: v.id("productionOrders"),
    outputLotId: v.id("inventoryLots"),
    componentLotId: v.id("inventoryLots"),
    componentProductId: v.id("products"),
    quantityBase: v.int64(),
    movementId: v.id("inventoryMovements"),
    movementLineId: v.id("inventoryMovementLines"),
  })
    .index("by_organizationId_and_outputLotId", [
      "organizationId",
      "outputLotId",
    ])
    .index("by_organizationId_and_componentLotId", [
      "organizationId",
      "componentLotId",
    ])
    .index("by_organizationId_and_productionOrderId", [
      "organizationId",
      "productionOrderId",
    ]),
  truckRouteSessions: defineTable({
    organizationId: v.string(),
    routeCode: v.string(),
    truckLocationId: v.id("inventoryLocations"),
    salespersonSubject: v.string(),
    assignedDeviceId: v.string(),
    status: v.union(
      v.literal("planned"),
      v.literal("loading"),
      v.literal("open"),
      v.literal("closing"),
      v.literal("reconciling"),
      v.literal("closed"),
      v.literal("review_required"),
    ),
    openedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    lastAcknowledgedSequence: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_salespersonSubject_and_status", [
      "organizationId",
      "salespersonSubject",
      "status",
    ])
    .index("by_organizationId_and_assignedDeviceId_and_status", [
      "organizationId",
      "assignedDeviceId",
      "status",
    ])
    .index("by_organizationId_and_truckLocationId_and_status", [
      "organizationId",
      "truckLocationId",
      "status",
    ]),
  truckInventoryCheckpoints: defineTable({
    organizationId: v.string(),
    routeSessionId: v.id("truckRouteSessions"),
    checkpointNumber: v.number(),
    serverSequence: v.number(),
    checksum: v.string(),
    createdAt: v.number(),
  }).index("by_organizationId_and_routeSessionId_and_checkpointNumber", [
    "organizationId",
    "routeSessionId",
    "checkpointNumber",
  ]),
  truckInventoryCheckpointLines: defineTable({
    organizationId: v.string(),
    checkpointId: v.id("truckInventoryCheckpoints"),
    productId: v.id("products"),
    lotId: v.optional(v.id("inventoryLots")),
    quantityBase: v.int64(),
    balanceVersion: v.number(),
  }).index("by_organizationId_and_checkpointId", [
    "organizationId",
    "checkpointId",
  ]),
  sapInventorySnapshots: defineTable({
    organizationId: v.string(),
    productCode: v.string(),
    warehouseCode: v.string(),
    productId: v.optional(v.id("products")),
    locationId: v.optional(v.id("inventoryLocations")),
    onHandBase: v.int64(),
    reservedBase: v.int64(),
    availableBase: v.int64(),
    asOf: v.number(),
    sourceEventId: v.string(),
    sourceSequence: v.optional(v.string()),
    payloadHash: v.optional(v.string()),
    resolutionStatus: v.union(
      v.literal("pending"),
      v.literal("matched"),
      v.literal("different"),
      v.literal("unmapped"),
    ),
    receivedAt: v.number(),
  })
    .index("by_organizationId_and_productCode_and_warehouseCode_and_asOf", [
      "organizationId",
      "productCode",
      "warehouseCode",
      "asOf",
    ])
    .index("by_organizationId_and_sourceEventId", [
      "organizationId",
      "sourceEventId",
    ])
    .index("by_organizationId_and_resolutionStatus_and_asOf", [
      "organizationId",
      "resolutionStatus",
      "asOf",
    ]),
  inventoryReconciliationRuns: defineTable({
    organizationId: v.string(),
    scope: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    convexCutoff: v.number(),
    sapCutoff: v.number(),
    comparedCount: v.number(),
    differenceCount: v.number(),
    startedBy: v.string(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_organizationId_and_status_and_startedAt", [
    "organizationId",
    "status",
    "startedAt",
  ]),
  inventoryReconciliationDifferences: defineTable({
    organizationId: v.string(),
    runId: v.id("inventoryReconciliationRuns"),
    productId: v.optional(v.id("products")),
    locationId: v.optional(v.id("inventoryLocations")),
    productCode: v.string(),
    warehouseCode: v.string(),
    convexBase: v.int64(),
    sapBase: v.int64(),
    differenceBase: v.int64(),
    classification: v.union(
      v.literal("mapping"),
      v.literal("timing"),
      v.literal("missing_inbound"),
      v.literal("missing_outbound"),
      v.literal("duplicate"),
      v.literal("unauthorized_adjustment"),
      v.literal("unresolved"),
    ),
    resolutionStatus: v.union(
      v.literal("open"),
      v.literal("resolved"),
      v.literal("accepted"),
    ),
    note: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_organizationId_and_runId", ["organizationId", "runId"])
    .index("by_organizationId_and_resolutionStatus_and_createdAt", [
      "organizationId",
      "resolutionStatus",
      "createdAt",
    ]),
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
    organizationId: v.optional(v.string()),
    clientRequestId: v.string(),
    orderNumber: v.string(),
    orderType: v.optional(v.string()),
    customerCode: v.string(),
    salespersonSubject: v.string(),
    status: orderStatus,
    subtotal: v.number(),
    total: v.number(),
    offlineCreatedAt: v.optional(v.number()),
    sapDocumentNumber: v.optional(v.string()),
    sourceLocationId: v.optional(v.id("inventoryLocations")),
    routeSessionId: v.optional(v.id("truckRouteSessions")),
    deviceId: v.optional(v.string()),
    inventoryMovementId: v.optional(v.id("inventoryMovements")),
    requestPayloadHash: v.optional(v.string()),
    deviceSequence: v.optional(v.number()),
    voidMovementId: v.optional(v.id("inventoryMovements")),
    originalOrderId: v.optional(v.id("orders")),
    voidedAt: v.optional(v.number()),
    voidedBy: v.optional(v.string()),
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
    organizationId: v.optional(v.string()),
    schemaVersion: v.optional(v.number()),
    payloadHash: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    causationId: v.optional(v.string()),
    sourceDocumentId: v.optional(v.string()),
    movementId: v.optional(v.id("inventoryMovements")),
    nextAttemptAt: v.optional(v.number()),
    acknowledgedAt: v.optional(v.number()),
    externalDocumentNumber: v.optional(v.string()),
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
  orgUnitTypes: defineTable({
    organizationId: v.string(),
    code: v.string(),
    label: v.string(),
    level: v.number(),
    active: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_level", ["organizationId", "level"]),
  orgUnits: defineTable({
    organizationId: v.string(),
    code: v.string(),
    name: v.string(),
    typeCode: v.string(),
    parentId: v.optional(v.id("orgUnits")),
    status: v.union(v.literal("active"), v.literal("inactive")),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    externalId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_parentId", ["organizationId", "parentId"])
    .index("by_organizationId_and_typeCode_and_status", [
      "organizationId",
      "typeCode",
      "status",
    ]),
  orgUnitParentEdges: defineTable({
    unitId: v.id("orgUnits"),
    parentId: v.id("orgUnits"),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_unitId_and_effectiveFrom", ["unitId", "effectiveFrom"])
    .index("by_parentId_and_effectiveFrom", ["parentId", "effectiveFrom"]),
  // Group-04 operational coverage identities; relationship rows are temporal authority.
  territories: defineTable({
    organizationId: v.string(),
    code: v.string(),
    name: v.string(),
    channel: v.optional(v.string()),
    boundaryGeoJson: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("inactive")),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_status", ["organizationId", "status"]),
  territoryOwnerships: defineTable({
    territoryId: v.id("territories"),
    orgUnitId: v.id("orgUnits"),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_territoryId_and_effectiveFrom", ["territoryId", "effectiveFrom"])
    .index("by_orgUnitId_and_effectiveFrom", ["orgUnitId", "effectiveFrom"]),
  territorySalespeople: defineTable({
    territoryId: v.id("territories"),
    profileId: v.id("profiles"),
    kind: v.optional(v.union(v.literal("primary"), v.literal("secondary"))),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_territoryId_and_effectiveFrom", ["territoryId", "effectiveFrom"])
    .index("by_profileId_and_effectiveFrom", ["profileId", "effectiveFrom"]),
  routes: defineTable({
    organizationId: v.string(),
    code: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("inactive")),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    weekdayTemplate: v.optional(v.array(v.number())),
    cycleDays: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_status", ["organizationId", "status"]),
  routeTerritories: defineTable({
    routeId: v.id("routes"),
    territoryId: v.id("territories"),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_routeId_and_effectiveFrom", ["routeId", "effectiveFrom"])
    .index("by_territoryId_and_effectiveFrom", [
      "territoryId",
      "effectiveFrom",
    ]),
  routeSalespeople: defineTable({
    routeId: v.id("routes"),
    profileId: v.id("profiles"),
    primary: v.boolean(),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_routeId_and_effectiveFrom", ["routeId", "effectiveFrom"])
    .index("by_profileId_and_effectiveFrom", ["profileId", "effectiveFrom"]),
  outlets: defineTable({
    organizationId: v.string(),
    code: v.string(),
    name: v.string(),
    status: v.union(
      v.literal("prospect"),
      v.literal("active"),
      v.literal("inactive"),
    ),
    custodianOrgUnitId: v.id("orgUnits"),
    channel: v.optional(v.string()),
    subchannel: v.optional(v.string()),
    classification: v.optional(v.string()),
    address: v.optional(v.string()),
    directions: v.optional(v.string()),
    contacts: v.optional(
      v.array(v.object({ name: v.string(), phone: v.optional(v.string()) })),
    ),
    photoStorageIds: v.optional(v.array(v.id("_storage"))),
    salesPotential: v.optional(v.number()),
    preferredWeekday: v.optional(v.number()),
    visitFrequencyDays: v.optional(v.number()),
    visitWindow: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_custodianOrgUnitId_and_status", [
      "custodianOrgUnitId",
      "status",
    ]),
  outletCustomerLinks: defineTable({
    outletId: v.id("outlets"),
    customerId: v.id("customers"),
    source: v.string(),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_outletId_and_effectiveFrom", ["outletId", "effectiveFrom"])
    .index("by_customerId_and_effectiveFrom", ["customerId", "effectiveFrom"]),
  outletPins: defineTable({
    outletId: v.id("outlets"),
    latitude: v.number(),
    longitude: v.number(),
    radiusMeters: v.number(),
    source: v.string(),
    evidenceStorageId: v.optional(v.id("_storage")),
    evidenceNote: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("verified"),
      v.literal("rejected"),
      v.literal("superseded"),
    ),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    proposedBy: v.string(),
    proposedAt: v.number(),
    verifiedBy: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    reviewerReason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_outletId_and_effectiveFrom", ["outletId", "effectiveFrom"])
    .index("by_outletId_and_status", ["outletId", "status"]),
  outletAssignments: defineTable({
    outletId: v.id("outlets"),
    territoryId: v.id("territories"),
    routeId: v.optional(v.id("routes")),
    sequence: v.optional(v.number()),
    preferredWeekday: v.optional(v.number()),
    cycleDays: v.optional(v.number()),
    visitWindow: v.optional(v.string()),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_outletId_and_effectiveFrom", ["outletId", "effectiveFrom"])
    .index("by_territoryId_and_effectiveFrom", ["territoryId", "effectiveFrom"])
    .index("by_routeId_and_effectiveFrom", ["routeId", "effectiveFrom"]),
  // Group-05 MCP: localMonth/serviceDate are Asia/Manila calendar strings;
  // all effective intervals are half-open UTC instants. Signed rows are versioned,
  // never folded into the legacy salesAssignments or visits tables.
  coveragePlans: defineTable({
    organizationId: v.string(),
    assigneeProfileId: v.id("profiles"),
    localMonth: v.string(), // YYYY-MM
    version: v.number(), // positive, allocated under the person/month index
    cycleType,
    orgUnitId: v.id("orgUnits"),
    territoryIds: v.array(v.id("territories")), // display, not an access grant
    requestedFrom: v.number(),
    requestedTo: v.number(),
    effectiveFrom: v.number(),
    effectiveTo: v.number(),
    status: planStatus,
    basedOnPlanId: v.optional(v.id("coveragePlans")),
    revisionReason: v.optional(v.string()),
    preparedBy: v.string(),
    preparedAt: v.number(),
    submittedBy: v.optional(v.string()),
    submittedAt: v.optional(v.number()),
    approvedBy: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    approvalSignature: v.optional(v.string()),
    activatedAt: v.optional(v.number()),
    supersededAt: v.optional(v.number()),
    activeThrough: v.optional(v.number()),
    contentRevision: v.number(),
    contentHash: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedBy: v.string(),
    updatedAt: v.number(),
  })
    .index("by_org_assignee_month_version", [
      "organizationId",
      "assigneeProfileId",
      "localMonth",
      "version",
    ])
    .index("by_org_month_status", ["organizationId", "localMonth", "status"])
    .index("by_assigneeProfileId_and_localMonth_and_status", [
      "assigneeProfileId",
      "localMonth",
      "status",
    ])
    .index("by_orgUnitId_and_localMonth_and_status", [
      "orgUnitId",
      "localMonth",
      "status",
    ])
    .index("by_status_and_effectiveFrom", ["status", "effectiveFrom"]),
  coverageAssignments: defineTable({
    planId: v.id("coveragePlans"),
    assigneeProfileId: v.id("profiles"),
    orgUnitId: v.id("orgUnits"),
    primary: v.boolean(),
    effectiveFrom: v.number(),
    effectiveTo: v.number(),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_planId_and_effectiveFrom", ["planId", "effectiveFrom"])
    .index("by_assigneeProfileId_and_effectiveFrom", [
      "assigneeProfileId",
      "effectiveFrom",
    ]),
  coveragePlanOutlets: defineTable({
    planId: v.id("coveragePlans"),
    outletId: v.id("outlets"),
    routeId: v.optional(v.id("routes")),
    territoryId: v.id("territories"),
    frequency,
    anchorLocalDate: v.optional(v.string()), // YYYY-MM-DD, Manila
    weekOrdinal: v.optional(v.number()), // monthly occurrence (1–5), validated by writer
    preferredWeekdays: v.array(weekday), // Sunday=0 … Saturday=6
    customLocalDates: v.array(v.string()), // explicit YYYY-MM-DD Manila dates
    sequence: v.optional(v.number()),
    priority: v.number(),
    expectedDurationMinutes: v.number(),
    requiredObjectives: v.array(v.string()),
    visitWindow: v.optional(v.string()),
    contentRevision: v.number(),
    updatedBy: v.string(),
    updatedAt: v.number(),
  })
    .index("by_planId_and_outletId", ["planId", "outletId"])
    .index("by_outletId_and_planId", ["outletId", "planId"]),
  coveragePlanSlots: defineTable({
    slotKey: v.string(), // stable across draft edits and generation retries
    planId: v.id("coveragePlans"),
    assigneeProfileId: v.id("profiles"),
    serviceDate: v.string(), // YYYY-MM-DD, Manila
    kind: slotKind,
    outletId: v.optional(v.id("outlets")),
    routeId: v.optional(v.id("routes")),
    activityKind: v.optional(v.string()),
    namedTruckRef: v.optional(v.string()), // business reference, not a POS session
    requiredObjectives: v.array(v.string()),
    intents: v.array(v.string()),
    sequence: v.number(),
    expectedDurationMinutes: v.number(),
    approvedSnapshot: v.optional(approvedOutletSnapshot),
    contentRevision: v.number(),
    updatedBy: v.string(),
    updatedAt: v.number(),
  })
    .index("by_planId_and_serviceDate", ["planId", "serviceDate"])
    .index("by_planId_and_serviceDate_and_slotKey", [
      "planId",
      "serviceDate",
      "slotKey",
    ])
    .index("by_outletId_and_serviceDate", ["outletId", "serviceDate"])
    .index("by_routeId_and_serviceDate", ["routeId", "serviceDate"]),
  positionRoutineTemplates: defineTable({
    organizationId: v.string(),
    positionId: v.id("positions"),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    weekday,
    dayKind: routineDayKind,
    activities: v.array(
      v.object({
        sequence: v.number(),
        name: v.string(),
        kind: slotKind,
      }),
    ),
    sourceRef: v.string(),
    provisional: v.boolean(),
    actorSubject: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_positionId_and_effectiveFrom", ["positionId", "effectiveFrom"])
    .index("by_positionId_and_weekday_and_effectiveFrom", [
      "positionId",
      "weekday",
      "effectiveFrom",
    ]),
  plannedVisits: defineTable({
    generationKey: v.string(),
    planId: v.id("coveragePlans"),
    planVersion: v.number(),
    planSlotId: v.id("coveragePlanSlots"),
    assigneeProfileId: v.id("profiles"),
    outletId: v.id("outlets"), // indexed projection of approvedSnapshot.outletId
    serviceDate: v.string(), // YYYY-MM-DD, Manila
    status: plannedVisitStatus,
    approvedSnapshot: approvedOutletSnapshot,
    requiredObjectives: v.array(v.string()),
    intents: v.array(v.string()),
    expectedDurationMinutes: v.number(),
    generatedAt: v.number(),
    replacedByVisitId: v.optional(v.id("plannedVisits")),
    replacementOfVisitId: v.optional(v.id("plannedVisits")),
    cancellationReason: v.optional(v.string()),
    cancelledAt: v.optional(v.number()),
  })
    .index("by_generationKey", ["generationKey"])
    .index("by_planId_and_serviceDate", ["planId", "serviceDate"])
    .index("by_assigneeProfileId_and_serviceDate", [
      "assigneeProfileId",
      "serviceDate",
    ])
    .index("by_outletId_and_serviceDate", ["outletId", "serviceDate"]),
  coverageAuditEvents: defineTable({
    planId: v.id("coveragePlans"),
    assigneeProfileId: v.id("profiles"),
    orgUnitId: v.id("orgUnits"),
    localMonth: v.string(),
    createdAt: v.number(),
    actorSubject: v.string(),
    action: v.string(),
    reason: v.optional(v.string()),
    affectedEntity: v.string(),
    affectedRowId: v.optional(v.string()),
    before: v.optional(v.record(v.string(), v.any())),
    after: v.optional(v.record(v.string(), v.any())),
    diff: v.optional(v.record(v.string(), v.any())),
    planVersion: v.number(),
    approvalSignatureRef: v.optional(v.string()),
  })
    .index("by_planId_and_createdAt", ["planId", "createdAt"])
    .index("by_assigneeProfileId_and_createdAt", [
      "assigneeProfileId",
      "createdAt",
    ])
    .index("by_orgUnitId_and_createdAt", ["orgUnitId", "createdAt"]),
  teams: defineTable({
    code: v.string(),
    name: v.string(),
    orgUnitId: v.id("orgUnits"),
    status: v.union(v.literal("active"), v.literal("inactive")),
    supervisorProfileId: v.optional(v.id("profiles")),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_code", ["code"])
    .index("by_orgUnitId", ["orgUnitId"]),
  teamMemberships: defineTable({
    teamId: v.id("teams"),
    profileId: v.id("profiles"),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_teamId_and_effectiveFrom", ["teamId", "effectiveFrom"])
    .index("by_profileId_and_effectiveFrom", ["profileId", "effectiveFrom"]),
  employeeAssignments: defineTable({
    profileId: v.id("profiles"),
    orgUnitId: v.optional(v.id("orgUnits")),
    role,
    positionId: v.optional(v.id("positions")),
    supervisorId: v.optional(v.id("profiles")),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    actorSubject: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_profileId_and_effectiveFrom", ["profileId", "effectiveFrom"])
    .index("by_orgUnitId_and_effectiveFrom", ["orgUnitId", "effectiveFrom"]),
  /**
   * Sunpride's job titles as data (ADR-009). A position is what the memo attaches standards
   * to — never a role, and never a code literal at an endpoint.
   */
  positions: defineTable({
    organizationId: v.string(),
    code: v.string(),
    label: v.string(),
    category: positionCategoryValidator,
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_code", ["organizationId", "code"])
    .index("by_organizationId_and_active", ["organizationId", "active"]),
  /**
   * Effective-dated standards per position, sourced from the client memo. History is kept:
   * a revised memo adds a row with a later `effectiveFrom` instead of overwriting.
   */
  positionStandards: defineTable({
    organizationId: v.string(),
    positionId: v.id("positions"),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    dailyCallsTarget: v.optional(v.number()),
    productiveCallTargetPct: v.optional(v.number()),
    workWithWeeklyMin: v.optional(v.number()),
    workWithMonthlyMin: v.optional(v.number()),
    sourceRef: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_positionId_and_effectiveFrom", ["positionId", "effectiveFrom"])
    .index("by_positionId_and_sourceRef", ["positionId", "sourceRef"])
    .index("by_organizationId_and_effectiveFrom", [
      "organizationId",
      "effectiveFrom",
    ]),
  productBarcodes: defineTable({
    organizationId: v.string(),
    productId: v.id("products"),
    barcode: v.string(),
    uomId: v.id("unitsOfMeasure"),
    active: v.boolean(),
    source: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_barcode", ["organizationId", "barcode"])
    .index("by_organizationId_and_productId", ["organizationId", "productId"]),
  importRuns: defineTable({
    organizationId: v.string(),
    importType: v.union(
      v.literal("products"),
      v.literal("opening_stock"),
      v.literal("stock_adjustment"),
      v.literal("cycle_count"),
      v.literal("mcp"),
    ),
    mcpPlanId: v.optional(v.id("coveragePlans")),
    runKey: v.string(),
    chunkIndex: v.number(),
    fileHash: v.string(),
    chunkHash: v.optional(v.string()),
    idempotencyKey: v.string(),
    actorSubject: v.string(),
    status: v.union(
      v.literal("previewed"),
      v.literal("committing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("submitted"),
    ),
    sourceReference: v.optional(v.string()),
    rowKeys: v.optional(v.array(v.string())),
    adjustmentType: v.optional(v.string()),
    reasonCode: v.optional(v.string()),
    locationIds: v.optional(v.array(v.id("inventoryLocations"))),
    adjustmentId: v.optional(v.id("inventoryAdjustments")),
    sessionId: v.optional(v.id("stockCountSessions")),
    rowCount: v.number(),
    fileRowCount: v.optional(v.number()),
    createdCount: v.number(),
    updatedCount: v.number(),
    skippedCount: v.number(),
    failedCount: v.number(),
    movementId: v.optional(v.id("inventoryMovements")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_organizationId_and_idempotencyKey", [
      "organizationId",
      "idempotencyKey",
    ])
    .index("by_organizationId_and_runKey", ["organizationId", "runKey"])
    .index("by_organizationId_and_type_and_fileHash", [
      "organizationId",
      "importType",
      "fileHash",
    ])
    .index("by_organizationId_and_createdAt", ["organizationId", "createdAt"]),
  // Mobile v1 is additive: the legacy `visits` table retains its original meaning.
  registeredDevices: defineTable({
    organizationId: v.string(),
    orgUnitId: v.optional(v.id("orgUnits")),
    inventoryTag: v.string(),
    profileId: v.optional(v.id("profiles")),
    boundSubject: v.optional(v.string()), // full identity.tokenIdentifier
    allowedApp: v.union(
      v.literal("IOS"),
      v.literal("ANDROID"),
      v.literal("VAN_ANDROID"),
    ),
    platform: v.string(),
    model: v.string(),
    osVersion: v.string(),
    appVersion: v.string(),
    publicKey: v.optional(v.string()),
    credentialId: v.optional(v.string()),
    attestation: v.optional(
      v.object({
        format: v.string(),
        keyId: v.optional(v.string()),
        verifiedAt: v.optional(v.number()),
      }),
    ),
    registeredAt: v.number(),
    lastSeenAt: v.optional(v.number()),
    status: v.union(
      v.literal("active"),
      v.literal("suspended"),
      v.literal("revoked"),
    ),
    statusActor: v.optional(v.string()),
    statusReason: v.optional(v.string()),
    statusAt: v.optional(v.number()),
  })
    .index("by_organizationId_and_inventoryTag", [
      "organizationId",
      "inventoryTag",
    ])
    .index("by_profileId_and_status", ["profileId", "status"])
    .index("by_credentialId", ["credentialId"]),
  deviceChallenges: defineTable({
    organizationId: v.string(),
    deviceId: v.id("registeredDevices"),
    nonce: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    issuedAt: v.number(),
  })
    .index("by_deviceId_and_nonce", ["deviceId", "nonce"])
    .index("by_expiresAt", ["expiresAt"]),
  visitExecutions: defineTable({
    organizationId: v.string(),
    clientVisitId: v.string(),
    plannedVisitId: v.optional(v.id("plannedVisits")),
    planId: v.optional(v.id("coveragePlans")),
    slotId: v.optional(v.id("coveragePlanSlots")),
    planVersion: v.optional(v.number()),
    assigneeProfileId: v.id("profiles"),
    outletId: v.id("outlets"),
    orgUnitId: v.id("orgUnits"),
    routeId: v.optional(v.id("routes")),
    customerId: v.optional(v.id("customers")),
    serviceDate: v.string(), // Asia/Manila YYYY-MM-DD; writer validates calendar and lineage
    source: v.union(v.literal("planned"), v.literal("unplanned")),
    intents: v.array(
      v.union(
        v.literal("sell"),
        v.literal("collect"),
        v.literal("merchandise"),
        v.literal("audit"),
        v.literal("deliver"),
        v.literal("promotion"),
        v.literal("complaint"),
        v.literal("follow-up"),
      ),
    ),
    state: v.union(
      v.literal("planned"),
      v.literal("arrived"),
      v.literal("checked-in"),
      v.literal("in-progress"),
      v.literal("checked-out"),
      v.literal("completed"),
      v.literal("skipped"),
      v.literal("rescheduled"),
      v.literal("missed"),
    ),
    outcome: v.optional(v.string()),
    reasonCode: v.optional(v.string()),
    productivity: v.union(
      v.literal("pending"),
      v.literal("verified"),
      v.literal("nonproductive"),
    ),
    ruleVersion: v.optional(v.string()),
    createdAt: v.number(),
    lastServerTime: v.number(),
    arrivedAt: v.optional(v.number()),
    checkedInAt: v.optional(v.number()),
    checkedOutAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    skippedAt: v.optional(v.number()),
    rescheduledAt: v.optional(v.number()),
    missedAt: v.optional(v.number()),
  })
    .index("by_organizationId_and_assigneeProfileId_and_serviceDate", [
      "organizationId",
      "assigneeProfileId",
      "serviceDate",
    ])
    .index("by_plannedVisitId", ["plannedVisitId"])
    .index("by_organizationId_and_clientVisitId", [
      "organizationId",
      "clientVisitId",
    ]),
  visitActivities: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    visitId: v.id("visitExecutions"),
    assigneeProfileId: v.id("profiles"),
    outletId: v.id("outlets"),
    activity: v.union(
      v.object({
        kind: v.literal("inventory_check"),
        productId: v.id("products"),
        observedQuantity: v.optional(v.number()),
        uomId: v.optional(v.id("unitsOfMeasure")),
        icoFinding: v.union(
          v.literal("present"),
          v.literal("absent"),
          v.literal("unknown"),
        ),
      }),
      v.object({
        kind: v.literal("merchandising"),
        displayCondition: v.union(
          v.literal("compliant"),
          v.literal("needs_action"),
          v.literal("not_present"),
        ),
        actionTaken: v.optional(v.string()),
      }),
      v.object({
        kind: v.literal("price_check"),
        productId: v.id("products"),
        observedPriceMinor: v.int64(),
        currency: v.string(),
        compliant: v.optional(v.boolean()),
      }),
      v.object({
        kind: v.literal("promotion"),
        programRef: v.string(),
        finding: v.union(
          v.literal("executed"),
          v.literal("not_executed"),
          v.literal("not_applicable"),
        ),
      }),
      v.object({
        kind: v.literal("order_intent"),
        clientOrderId: v.string(),
        note: v.optional(v.string()),
      }),
      v.object({ kind: v.literal("note"), text: v.string() }),
    ),
    evidenceIds: v.array(v.id("fieldEvidenceFiles")),
    deviceTime: v.number(),
    serverTime: v.number(),
  }).index("by_visitId_and_serverTime", ["visitId", "serverTime"]),
  visitLocationEvidence: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    visitId: v.id("visitExecutions"),
    event: v.union(v.literal("check_in"), v.literal("check_out")),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    provider: v.union(
      v.literal("gps"),
      v.literal("network"),
      v.literal("fused"),
      v.literal("unknown"),
    ),
    accuracyMeters: v.optional(v.number()),
    mockSignal: v.optional(v.boolean()),
    integritySignal: v.optional(v.string()),
    pinId: v.optional(v.id("outletPins")),
    pinVersion: v.optional(v.string()),
    policyVersion: v.string(),
    radiusMeters: v.optional(v.number()),
    distanceMeters: v.optional(v.number()),
    result: v.union(
      v.literal("within_radius"),
      v.literal("outside_radius"),
      v.literal("unavailable"),
      v.literal("unreliable"),
    ),
    reviewStatus: v.union(
      v.literal("pending_review"),
      v.literal("verified"),
      v.literal("approved_exception"),
      v.literal("rejected"),
    ),
    deviceTime: v.number(),
    serverTime: v.number(),
    retentionDueAt: v.optional(v.number()),
  })
    .index("by_visitId_and_serverTime", ["visitId", "serverTime"])
    .index("by_orgUnitId_and_reviewStatus_and_serverTime", [
      "orgUnitId",
      "reviewStatus",
      "serverTime",
    ])
    .index("by_retentionDueAt", ["retentionDueAt"]),
  fieldTasks: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    assigneeProfileId: v.id("profiles"),
    planId: v.optional(v.id("coveragePlans")),
    outletId: v.optional(v.id("outlets")),
    visitId: v.optional(v.id("visitExecutions")),
    kind: v.union(
      v.literal("inventory_check"),
      v.literal("merchandising"),
      v.literal("price_check"),
      v.literal("promotion"),
      v.literal("follow_up"),
    ),
    required: v.boolean(),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    status: v.union(
      v.literal("open"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
    evidenceIds: v.array(v.id("fieldEvidenceFiles")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_assigneeProfileId_and_effectiveFrom", [
      "assigneeProfileId",
      "effectiveFrom",
    ])
    .index("by_visitId", ["visitId"]),
  fieldCollections: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    customerId: v.id("customers"),
    outletId: v.id("outlets"),
    visitId: v.id("visitExecutions"),
    assigneeProfileId: v.id("profiles"),
    amountMinor: v.int64(), // writer enforces positive amount; never a financial posting
    currency: v.string(),
    method: v.string(),
    reference: v.string(),
    status: v.union(
      v.literal("recorded"),
      v.literal("pending_review"),
      v.literal("rejected"),
    ),
    deviceTime: v.number(),
    serverTime: v.number(),
  })
    .index("by_visitId_and_serverTime", ["visitId", "serverTime"])
    .index("by_customerId_and_serverTime", ["customerId", "serverTime"]),
  fieldEvidenceFiles: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    storageId: v.id("_storage"),
    visitId: v.id("visitExecutions"),
    activityId: v.optional(v.id("visitActivities")),
    taskId: v.optional(v.id("fieldTasks")),
    ownerProfileId: v.id("profiles"),
    outletId: v.id("outlets"),
    mime: v.string(),
    sizeBytes: v.number(),
    checksum: v.string(),
    capturedAt: v.number(),
    uploadedAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("verified"),
      v.literal("rejected"),
    ),
    retentionDueAt: v.optional(v.number()),
    redactedAt: v.optional(v.number()),
  })
    .index("by_visitId_and_uploadedAt", ["visitId", "uploadedAt"])
    .index("by_orgUnitId_and_uploadedAt", ["orgUnitId", "uploadedAt"]),
  executionEvents: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    entityType: v.union(
      v.literal("visit"),
      v.literal("activity"),
      v.literal("task"),
      v.literal("collection"),
      v.literal("device"),
      v.literal("order"),
      v.literal("inventory"),
    ),
    entityId: v.string(),
    kind: v.string(),
    actorSubject: v.string(), // full identity.tokenIdentifier
    actorRole: role,
    actorOrgUnitId: v.id("orgUnits"),
    deviceId: v.optional(v.id("registeredDevices")),
    source: v.union(v.literal("mobile"), v.literal("web"), v.literal("system")),
    operationKey: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    occurredAt: v.number(),
    serverAt: v.number(),
    summary: v.object({
      before: v.optional(v.string()),
      after: v.optional(v.string()),
      reasonCode: v.optional(v.string()),
    }),
    schemaVersion: v.number(),
    policyVersion: v.optional(v.string()),
  })
    .index("by_entityType_and_entityId_and_serverAt", [
      "entityType",
      "entityId",
      "serverAt",
    ])
    .index("by_orgUnitId_and_serverAt", ["orgUnitId", "serverAt"])
    .index("by_organizationId_and_serverAt", ["organizationId", "serverAt"]),
  processedMobileOperations: defineTable({
    organizationId: v.string(),
    kind: v.union(
      v.literal("visit.checkIn"),
      v.literal("visit.activity"),
      v.literal("visit.checkOut"),
      v.literal("task.complete"),
      v.literal("collection.record"),
    ),
    clientRequestId: v.string(),
    profileId: v.id("profiles"),
    deviceId: v.id("registeredDevices"),
    payloadHash: v.string(),
    result: v.object({
      entityId: v.string(),
      eventIds: v.array(v.id("executionEvents")),
      serverTime: v.number(),
    }),
    serverAt: v.number(),
  }).index("by_organizationId_and_kind_and_clientRequestId", [
    "organizationId",
    "kind",
    "clientRequestId",
  ]),
  mobileChanges: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    sequence: v.number(), // monotonic per organization, allocated transactionally by writer
    entity: v.string(),
    entityId: v.string(),
    revision: v.number(),
    op: v.union(v.literal("upsert"), v.literal("tombstone")),
    ownerProfileId: v.optional(v.id("profiles")),
    ownerSubject: v.optional(v.string()), // full identity.tokenIdentifier
    serverAt: v.number(),
    payloadVersion: v.number(),
  })
    .index("by_organizationId_and_sequence", ["organizationId", "sequence"])
    .index("by_orgUnitId_and_sequence", ["orgUnitId", "sequence"]),
  mobileSyncState: defineTable({
    organizationId: v.string(),
    orgUnitId: v.id("orgUnits"),
    deviceId: v.id("registeredDevices"),
    watermark: v.number(),
    scopeFingerprint: v.string(),
    leaseIssuedAt: v.number(),
    leaseExpiresAt: v.number(),
    updatedAt: v.number(),
  }).index("by_deviceId", ["deviceId"]),
  importRunErrors: defineTable({
    organizationId: v.string(),
    runId: v.id("importRuns"),
    rowNumber: v.number(),
    column: v.optional(v.string()),
    code: v.string(),
    message: v.string(),
    rawRow: v.string(),
    createdAt: v.number(),
  }).index("by_organizationId_and_runId_and_rowNumber", [
    "organizationId",
    "runId",
    "rowNumber",
  ]),
});
