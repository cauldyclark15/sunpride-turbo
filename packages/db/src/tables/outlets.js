// @ts-check
/**
 * Outlets, pins, assignments, enrolment. Row shapes for migration 0103_outlets.sql.
 * Tables: outlets, outlet_contacts, outlet_photos, outlet_customer_links, outlet_pins, outlet_assignments, outlet_enrolments, outlet_enrolment_photos, outlet_enrolment_events, outlet_code_settings.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const OUTLET_STATUS = /** @type {const} */ (["prospect", "active", "inactive"]);
export const OUTLET_ENROLMENT_STATUS = /** @type {const} */ (["provisional", "approved", "rejected"]);
export const OUTLET_PIN_STATUS = /** @type {const} */ (["pending", "verified", "rejected", "superseded"]);
export const OUTLET_ENROLMENTS_STATUS = /** @type {const} */ (["pending", "approved", "rejected"]);
export const OUTLET_ENROLMENT_EVENT_KIND = /** @type {const} */ (["proposed", "approved", "rejected"]);

/**
 * `outlets` (Convex `outlets`)
 * @typedef {Object} OutletRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} name
 * @property {"prospect" | "active" | "inactive"} status
 * @property {string} custodianOrgUnitId
 * @property {string | null} channel
 * @property {string | null} subchannel
 * @property {string | null} classification
 * @property {string | null} address
 * @property {string | null} directions
 * @property {number | null} salesPotential
 * @property {number | null} preferredWeekday
 * @property {number | null} visitFrequencyDays
 * @property {string | null} visitWindow
 * @property {"provisional" | "approved" | "rejected" | null} enrolmentStatus
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_contacts` (Convex `outlets`, child of `outlets`)
 * @typedef {Object} OutletContactRow
 * @property {string} id
 * @property {string} outletId
 * @property {number} ordinal
 * @property {string} name
 * @property {string | null} phone
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_photos` (Convex `outlets`, child of `outlets`)
 * @typedef {Object} OutletPhotoRow
 * @property {string} id
 * @property {string} outletId
 * @property {number} ordinal
 * @property {string} fileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_customer_links` (Convex `outletCustomerLinks`)
 * @typedef {Object} OutletCustomerLinkRow
 * @property {string} id
 * @property {string} outletId
 * @property {string} customerId
 * @property {string} source
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_pins` (Convex `outletPins`)
 * @typedef {Object} OutletPinRow
 * @property {string} id
 * @property {string} outletId
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} radiusMeters
 * @property {string} source
 * @property {string | null} evidenceStorageId
 * @property {string | null} evidenceNote
 * @property {"pending" | "verified" | "rejected" | "superseded"} status
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} proposedBy
 * @property {Date} proposedAt
 * @property {string | null} verifiedBy
 * @property {Date | null} verifiedAt
 * @property {string | null} reviewerReason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_assignments` (Convex `outletAssignments`)
 * @typedef {Object} OutletAssignmentRow
 * @property {string} id
 * @property {string} outletId
 * @property {string} territoryId
 * @property {string | null} routeId
 * @property {number | null} sequence
 * @property {number | null} preferredWeekday
 * @property {number | null} cycleDays
 * @property {string | null} visitWindow
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_enrolments` (Convex `outletEnrolments`)
 * @typedef {Object} OutletEnrolmentRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} outletId
 * @property {string} orgUnitId
 * @property {string | null} territoryId
 * @property {string} pinId
 * @property {"pending" | "approved" | "rejected"} status
 * @property {string} provisionalCode
 * @property {string | null} assignedCode
 * @property {string | null} cisStorageId
 * @property {string} clientRequestId
 * @property {string} proposedBy
 * @property {string} proposedByProfileId
 * @property {Date} proposedAt
 * @property {string | null} decidedBy
 * @property {Date | null} decidedAt
 * @property {string | null} decisionReason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_enrolment_photos` (Convex `outletEnrolments`, child of `outlet_enrolments`)
 * @typedef {Object} OutletEnrolmentPhotoRow
 * @property {string} id
 * @property {string} outletEnrolmentId
 * @property {number} ordinal
 * @property {string} fileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_enrolment_events` (Convex `outletEnrolmentEvents`)
 * @typedef {Object} OutletEnrolmentEventRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} enrolmentId
 * @property {string} outletId
 * @property {string} orgUnitId
 * @property {"proposed" | "approved" | "rejected"} kind
 * @property {string} outletName
 * @property {string} outletCode
 * @property {string} actorName
 * @property {string} proposedByProfileId
 * @property {string | null} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `outlet_code_settings` (Convex `outletCodeSettings`)
 * @typedef {Object} OutletCodeSettingRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} prefix
 * @property {number} digits
 * @property {number} nextSequence
 * @property {number} nextProvisionalSequence
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
