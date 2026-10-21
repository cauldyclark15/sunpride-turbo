// @ts-check
/**
 * Merchandising audits and assortments. Row shapes for migration 0106_merchandising.sql.
 * Tables: outlet_assortments, outlet_assortment_products, merchandising_audits, merchandising_audit_missing_products, merchandising_audit_evidence, merchandising_availability, merchandising_availability_evidence, merchandising_compliance_checks, merchandising_compliance_check_evidence, competitor_observations, competitor_observation_evidence.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const MERCHANDISING_AUDIT_SOURCE = /** @type {const} */ ([
  "mobile",
  "web",
]);
export const MERCHANDISING_AVAILABILITY_STATUS = /** @type {const} */ ([
  "available",
  "low_stock",
  "out_of_stock",
  "not_carried",
]);
export const MERCHANDISING_COMPLIANCE_CHECK_KIND = /** @type {const} */ ([
  "display",
  "price_tag",
  "promotion",
  "freezer_placement",
  "shelf_share",
  "product_freshness",
]);
export const MERCHANDISING_COMPLIANCE_CHECK_FINDING = /** @type {const} */ ([
  "compliant",
  "non_compliant",
  "not_present",
  "not_applicable",
]);
export const COMPETITOR_OBSERVATION_KIND = /** @type {const} */ ([
  "price",
  "promotion",
  "display",
  "new_product",
  "stock_level",
  "other",
]);

/**
 * `outlet_assortments`
 * @typedef {Object} OutletAssortmentRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} outletId
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} sourceRef
 * @property {string} actorSubject
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `outlet_assortment_products` (child of `outlet_assortments`)
 * @typedef {Object} OutletAssortmentProductRow
 * @property {string} id
 * @property {string} outletAssortmentId
 * @property {number} ordinal
 * @property {string} productId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `merchandising_audits`
 * @typedef {Object} MerchandisingAuditRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} visitId
 * @property {string} outletId
 * @property {string} assigneeProfileId
 * @property {Date} serviceDate
 * @property {string} clientAuditId
 * @property {string} payloadHash
 * @property {string} auditVersion
 * @property {string | null} assortmentId
 * @property {number} requiredCount
 * @property {number} requiredAvailableCount
 * @property {number} requiredOutOfStockCount
 * @property {string} actorSubject
 * @property {"mobile" | "web"} source
 * @property {Date} deviceTime
 * @property {Date} serverTime
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `merchandising_audit_missing_products` (child of `merchandising_audits`)
 * @typedef {Object} MerchandisingAuditMissingProductRow
 * @property {string} id
 * @property {string} merchandisingAuditId
 * @property {number} ordinal
 * @property {string} productId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `merchandising_audit_evidence` (child of `merchandising_audits`)
 * @typedef {Object} MerchandisingAuditEvidenceRow
 * @property {string} id
 * @property {string} merchandisingAuditId
 * @property {number} ordinal
 * @property {string} evidenceFileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `merchandising_availability`
 * @typedef {Object} MerchandisingAvailabilityRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} auditId
 * @property {string} outletId
 * @property {string} productId
 * @property {Date} serviceDate
 * @property {boolean} required
 * @property {"available" | "low_stock" | "out_of_stock" | "not_carried"} status
 * @property {number | null} facings
 * @property {string | null} note
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `merchandising_availability_evidence` (child of `merchandising_availability`)
 * @typedef {Object} MerchandisingAvailabilityEvidenceRow
 * @property {string} id
 * @property {string} merchandisingAvailabilityId
 * @property {number} ordinal
 * @property {string} evidenceFileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `merchandising_compliance_checks`
 * @typedef {Object} MerchandisingComplianceCheckRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} auditId
 * @property {string} outletId
 * @property {Date} serviceDate
 * @property {"display" | "price_tag" | "promotion" | "freezer_placement" | "shelf_share" | "product_freshness"} kind
 * @property {"compliant" | "non_compliant" | "not_present" | "not_applicable"} finding
 * @property {string | null} programRef
 * @property {number | null} shareOfShelfPercent
 * @property {string | null} actionTaken
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `merchandising_compliance_check_evidence` (child of `merchandising_compliance_checks`)
 * @typedef {Object} MerchandisingComplianceCheckEvidenceRow
 * @property {string} id
 * @property {string} merchandisingComplianceCheckId
 * @property {number} ordinal
 * @property {string} evidenceFileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `competitor_observations`
 * @typedef {Object} CompetitorObservationRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} auditId
 * @property {string} outletId
 * @property {Date} serviceDate
 * @property {"price" | "promotion" | "display" | "new_product" | "stock_level" | "other"} kind
 * @property {string} brand
 * @property {string | null} productCategory
 * @property {string | null} observedPriceMinor
 * @property {string | null} currency
 * @property {string | null} note
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `competitor_observation_evidence` (child of `competitor_observations`)
 * @typedef {Object} CompetitorObservationEvidenceRow
 * @property {string} id
 * @property {string} competitorObservationId
 * @property {number} ordinal
 * @property {string} evidenceFileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

export {};
