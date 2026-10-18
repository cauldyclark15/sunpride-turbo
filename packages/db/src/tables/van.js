// @ts-check
/**
 * Van sales: vehicles, trips, loads, damage, credit terms. Row shapes for migration 0110_van.sql.
 * Tables: vehicles, van_trips, van_trip_loads, van_trip_load_lines, van_operations, van_damage_records, van_damage_photos, outlet_credit_terms.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const VEHICLE_STATUS = /** @type {const} */ (["active", "inactive"]);
export const VAN_TRIP_STATUS = /** @type {const} */ (["planned", "loading", "loaded", "active", "closing", "reconciling", "closed", "cancelled", "review_required"]);
export const VAN_TRIP_LOAD_STATUS = /** @type {const} */ (["planned", "discrepancy", "posted", "cancelled"]);
export const VAN_TRIP_LOAD_LINE_DISCREPANCY_REASON = /** @type {const} */ (["short_loaded", "over_loaded", "damaged_at_loading", "wrong_item", "other"]);
export const VAN_OPERATION_KIND = /** @type {const} */ (["trip.start", "load.confirm", "truck.damage"]);
export const VAN_DAMAGE_RECORD_REASON = /** @type {const} */ (["crushed", "leaking", "expired", "spoiled", "other"]);
export const VAN_DAMAGE_RECORD_STATUS = /** @type {const} */ (["recorded", "pending_approval", "approved", "rejected"]);

/**
 * `vehicles` (Convex `vehicles`)
 * @typedef {Object} VehicleRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} vehicleCode
 * @property {string} plateNumber
 * @property {string | null} name
 * @property {string} truckLocationId
 * @property {string} homeLocationId
 * @property {string | null} capacityNote
 * @property {"active" | "inactive"} status
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `van_trips` (Convex `vanTrips`)
 * @typedef {Object} VanTripRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} tripNumber
 * @property {string} vehicleId
 * @property {string} truckLocationId
 * @property {string} sourceLocationId
 * @property {string | null} routeId
 * @property {Date} serviceDate
 * @property {string} salespersonProfileId
 * @property {string} salespersonSubject
 * @property {string | null} driverName
 * @property {string | null} helperName
 * @property {"planned" | "loading" | "loaded" | "active" | "closing" | "reconciling" | "closed" | "cancelled" | "review_required"} status
 * @property {Date | null} startedAt
 * @property {string | null} startedDeviceId
 * @property {number | null} startOdometerKm
 * @property {string | null} startNote
 * @property {string | null} routeSessionId
 * @property {Date | null} closedAt
 * @property {Date | null} cancelledAt
 * @property {string | null} cancelReason
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `van_trip_loads` (Convex `vanTripLoads`)
 * @typedef {Object} VanTripLoadRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} tripId
 * @property {number} loadNumber
 * @property {"planned" | "discrepancy" | "posted" | "cancelled"} status
 * @property {string} createdBy
 * @property {string | null} confirmedBy
 * @property {Date | null} confirmedAt
 * @property {string | null} confirmedDeviceId
 * @property {string | null} confirmRequestId
 * @property {string | null} approvedBy
 * @property {Date | null} approvedAt
 * @property {string | null} approvalNote
 * @property {string | null} commandKey
 * @property {string | null} movementId
 * @property {string | null} stockTransferId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `van_trip_load_lines` (Convex `vanTripLoadLines`)
 * @typedef {Object} VanTripLoadLineRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} loadId
 * @property {string} tripId
 * @property {number} lineNumber
 * @property {string} productId
 * @property {string} productCode
 * @property {string} uomCode
 * @property {string} quantityScale
 * @property {string | null} lotId
 * @property {string | null} lotNumber
 * @property {string} expectedBase
 * @property {string | null} actualBase
 * @property {"short_loaded" | "over_loaded" | "damaged_at_loading" | "wrong_item" | "other" | null} discrepancyReason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `van_operations` (Convex `vanOperations`)
 * @typedef {Object} VanOperationRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} deviceId
 * @property {string} profileId
 * @property {"trip.start" | "load.confirm" | "truck.damage"} kind
 * @property {string} clientRequestId
 * @property {string} payloadHash
 * @property {string} entityId
 * @property {string | null} movementId
 * @property {Date} serverAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `van_damage_records` (Convex `vanDamageRecords`)
 * @typedef {Object} VanDamageRecordRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} tripId
 * @property {string} orgUnitId
 * @property {string} truckLocationId
 * @property {string} productId
 * @property {string} productCode
 * @property {string} uomCode
 * @property {string} quantityScale
 * @property {string} quantityBase
 * @property {"crushed" | "leaking" | "expired" | "spoiled" | "other"} reason
 * @property {string | null} note
 * @property {string | null} photoId
 * @property {boolean} needsApproval
 * @property {"recorded" | "pending_approval" | "approved" | "rejected"} status
 * @property {string} recordedBy
 * @property {string} recordedProfileId
 * @property {string} deviceId
 * @property {string} clientRequestId
 * @property {Date} recordedAt
 * @property {string} movementId
 * @property {string | null} decidedBy
 * @property {Date | null} decidedAt
 * @property {string | null} decisionNote
 * @property {string | null} reversalMovementId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `van_damage_photos` (Convex `vanDamagePhotos`)
 * @typedef {Object} VanDamagePhotoRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} profileId
 * @property {string} deviceId
 * @property {string} sha256
 * @property {string} storageId
 * @property {string} size
 * @property {string | null} damageRecordId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_credit_terms` (Convex `outletCreditTerms`)
 * @typedef {Object} OutletCreditTermRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} outletId
 * @property {number} termsDays
 * @property {string} creditLimitMinor
 * @property {string} currency
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} sourceRef
 * @property {string} actorSubject
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

export {};
