// @ts-check
/**
 * Visit execution, activities, evidence, tasks, collections. Row shapes for migration 0105_visits.sql.
 * Tables: visit_executions, visit_activities, visit_activity_evidence, visit_activity_rules, visit_activity_rule_activities, visit_location_evidence, field_tasks, field_task_evidence, field_collections, evidence_upload_claims, field_evidence_files, execution_events.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const VISIT_EXECUTION_SOURCE = /** @type {const} */ (["planned", "unplanned"]);
export const VISIT_EXECUTION_INTENT = /** @type {const} */ (["sell", "collect", "merchandise", "audit", "deliver", "promotion", "complaint", "follow-up"]);
export const VISIT_EXECUTION_STATE = /** @type {const} */ (["planned", "arrived", "checked-in", "in-progress", "checked-out", "completed", "skipped", "rescheduled", "missed"]);
export const VISIT_EXECUTION_PRODUCTIVITY = /** @type {const} */ (["pending", "verified", "nonproductive"]);
export const VISIT_EXECUTION_LATE_REVIEW_STATUS = /** @type {const} */ (["pending_review", "accepted", "rejected"]);
export const VISIT_ACTIVITY_ACTIVITY_KIND = /** @type {const} */ (["inventory_check", "merchandising", "price_check", "promotion", "order_intent", "note", "call_sheet"]);
export const VISIT_ACTIVITY_RULE_ACTIVITY_KIND = /** @type {const} */ (["call_sheet", "merchandising", "inventory_check", "price_check", "promotion", "order_intent", "note"]);
export const VISIT_LOCATION_EVIDENCE_EVENT = /** @type {const} */ (["check_in", "check_out"]);
export const VISIT_LOCATION_EVIDENCE_PROVIDER = /** @type {const} */ (["gps", "network", "fused", "unknown"]);
export const VISIT_LOCATION_EVIDENCE_RESULT = /** @type {const} */ (["within_radius", "outside_radius", "unavailable", "unreliable"]);
export const VISIT_LOCATION_EVIDENCE_REVIEW_STATUS = /** @type {const} */ (["pending_review", "verified", "approved_exception", "rejected"]);
export const FIELD_TASK_KIND = /** @type {const} */ (["inventory_check", "merchandising", "price_check", "promotion", "follow_up"]);
export const FIELD_TASK_STATUS = /** @type {const} */ (["open", "completed", "cancelled"]);
export const FIELD_COLLECTION_STATUS = /** @type {const} */ (["recorded", "pending_review", "rejected"]);
export const FIELD_EVIDENCE_FILE_STATUS = /** @type {const} */ (["pending", "verified", "rejected"]);
export const EXECUTION_EVENT_ENTITY_TYPE = /** @type {const} */ (["visit", "activity", "task", "collection", "device", "order", "inventory"]);
export const EXECUTION_EVENT_ACTOR_ROLE = /** @type {const} */ (["super_admin", "admin", "operations", "manager", "approver", "sales", "analyst", "viewer"]);
export const EXECUTION_EVENT_SOURCE = /** @type {const} */ (["mobile", "web", "system"]);

/**
 * `visit_executions` (Convex `visitExecutions`)
 * @typedef {Object} VisitExecutionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} clientVisitId
 * @property {string | null} plannedVisitId
 * @property {string | null} planId
 * @property {string | null} slotId
 * @property {number | null} planVersion
 * @property {string} assigneeProfileId
 * @property {string} outletId
 * @property {string} orgUnitId
 * @property {string | null} routeId
 * @property {string | null} customerId
 * @property {Date} serviceDate
 * @property {"planned" | "unplanned"} source
 * @property {Array<"sell" | "collect" | "merchandise" | "audit" | "deliver" | "promotion" | "complaint" | "follow-up">} intents
 * @property {"planned" | "arrived" | "checked-in" | "in-progress" | "checked-out" | "completed" | "skipped" | "rescheduled" | "missed"} state
 * @property {string | null} outcome
 * @property {string | null} reasonCode
 * @property {string | null} unplannedReason
 * @property {"pending" | "verified" | "nonproductive"} productivity
 * @property {string | null} ruleVersion
 * @property {Date} lastServerTime
 * @property {Date | null} arrivedAt
 * @property {Date | null} checkedInAt
 * @property {Date | null} checkedOutAt
 * @property {Date | null} completedAt
 * @property {Date | null} skippedAt
 * @property {Date | null} rescheduledAt
 * @property {Date | null} missedAt
 * @property {Date | null} startedAt
 * @property {Date | null} endedAt
 * @property {string | null} callDurationMs
 * @property {Date | null} lateSyncAt
 * @property {"pending_review" | "accepted" | "rejected" | null} lateReviewStatus
 * @property {string | null} activityRuleVersion
 * @property {string[]} missingActivities
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `visit_activities` (Convex `visitActivities`)
 * @typedef {Object} VisitActivityRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} visitId
 * @property {string} assigneeProfileId
 * @property {string} outletId
 * @property {"inventory_check" | "merchandising" | "price_check" | "promotion" | "order_intent" | "note" | "call_sheet"} activityKind
 * @property {Record<string, unknown>} activity
 * @property {Date} deviceTime
 * @property {Date} serverTime
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `visit_activity_evidence` (Convex `visitActivities`, child of `visit_activities`)
 * @typedef {Object} VisitActivityEvidenceRow
 * @property {string} id
 * @property {string} visitActivityId
 * @property {number} ordinal
 * @property {string} evidenceFileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `visit_activity_rules` (Convex `visitActivityRules`)
 * @typedef {Object} VisitActivityRuleRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} intent
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} sourceRef
 * @property {boolean} provisional
 * @property {string} actorSubject
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `visit_activity_rule_activities` (Convex `visitActivityRules`, child of `visit_activity_rules`)
 * @typedef {Object} VisitActivityRuleActivityRow
 * @property {string} id
 * @property {string} visitActivityRuleId
 * @property {number} ordinal
 * @property {"call_sheet" | "merchandising" | "inventory_check" | "price_check" | "promotion" | "order_intent" | "note"} kind
 * @property {boolean} required
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `visit_location_evidence` (Convex `visitLocationEvidence`)
 * @typedef {Object} VisitLocationEvidenceRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} visitId
 * @property {"check_in" | "check_out"} event
 * @property {number | null} latitude
 * @property {number | null} longitude
 * @property {"gps" | "network" | "fused" | "unknown"} provider
 * @property {number | null} accuracyMeters
 * @property {boolean | null} mockSignal
 * @property {string | null} integritySignal
 * @property {string | null} pinId
 * @property {string | null} pinVersion
 * @property {string} policyVersion
 * @property {number | null} radiusMeters
 * @property {number | null} distanceMeters
 * @property {"within_radius" | "outside_radius" | "unavailable" | "unreliable"} result
 * @property {"pending_review" | "verified" | "approved_exception" | "rejected"} reviewStatus
 * @property {Date} deviceTime
 * @property {Date} serverTime
 * @property {Date | null} retentionDueAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `field_tasks` (Convex `fieldTasks`)
 * @typedef {Object} FieldTaskRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} assigneeProfileId
 * @property {string | null} planId
 * @property {string | null} outletId
 * @property {string | null} visitId
 * @property {"inventory_check" | "merchandising" | "price_check" | "promotion" | "follow_up"} kind
 * @property {boolean} required
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {"open" | "completed" | "cancelled"} status
 * @property {Date | null} completedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `field_task_evidence` (Convex `fieldTasks`, child of `field_tasks`)
 * @typedef {Object} FieldTaskEvidenceRow
 * @property {string} id
 * @property {string} fieldTaskId
 * @property {number} ordinal
 * @property {string} evidenceFileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `field_collections` (Convex `fieldCollections`)
 * @typedef {Object} FieldCollectionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} customerId
 * @property {string} outletId
 * @property {string} visitId
 * @property {string} assigneeProfileId
 * @property {string} amountMinor
 * @property {string} currency
 * @property {string} method
 * @property {string} reference
 * @property {"recorded" | "pending_review" | "rejected"} status
 * @property {Date} deviceTime
 * @property {Date} serverTime
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `evidence_upload_claims` (Convex `evidenceUploadClaims`)
 * @typedef {Object} EvidenceUploadClaimRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} visitId
 * @property {string} profileId
 * @property {string | null} deviceId
 * @property {string} subject
 * @property {Date} issuedAt
 * @property {Date} expiresAt
 * @property {Date | null} consumedAt
 * @property {string | null} storageId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `field_evidence_files` (Convex `fieldEvidenceFiles`)
 * @typedef {Object} FieldEvidenceFileRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} storageId
 * @property {string} visitId
 * @property {string | null} activityId
 * @property {string | null} taskId
 * @property {string} ownerProfileId
 * @property {string} outletId
 * @property {string} mime
 * @property {string} sizeBytes
 * @property {string} checksum
 * @property {Date} capturedAt
 * @property {string | null} photoType
 * @property {Date} uploadedAt
 * @property {"pending" | "verified" | "rejected"} status
 * @property {Date | null} retentionDueAt
 * @property {Date | null} redactedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `execution_events` (Convex `executionEvents`)
 * @typedef {Object} ExecutionEventRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {"visit" | "activity" | "task" | "collection" | "device" | "order" | "inventory"} entityType
 * @property {string} entityId
 * @property {string} kind
 * @property {string} actorSubject
 * @property {"super_admin" | "admin" | "operations" | "manager" | "approver" | "sales" | "analyst" | "viewer"} actorRole
 * @property {string} actorOrgUnitId
 * @property {string | null} deviceId
 * @property {"mobile" | "web" | "system"} source
 * @property {string | null} operationKey
 * @property {string | null} correlationId
 * @property {Date} occurredAt
 * @property {Date} serverAt
 * @property {string | null} summaryBefore
 * @property {string | null} summaryAfter
 * @property {string | null} summaryReasonCode
 * @property {number} schemaVersion
 * @property {string | null} policyVersion
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
