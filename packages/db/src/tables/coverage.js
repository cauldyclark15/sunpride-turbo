// @ts-check
/**
 * Coverage plans (MCP), slots, planned visits. Row shapes for migration 0104_coverage.sql.
 * Tables: coverage_plans, coverage_plan_territories, coverage_assignments, coverage_plan_outlets, coverage_plan_slots, position_routine_templates, position_routine_template_activities, planned_visits, supervisor_away_periods, coverage_audit_events.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const COVERAGE_PLAN_CYCLE_TYPE = /** @type {const} */ (["monthly"]);
export const COVERAGE_PLAN_STATUS = /** @type {const} */ ([
  "draft",
  "submitted",
  "approved",
  "active",
  "superseded",
]);
export const COVERAGE_PLAN_APPROVAL_CAPACITY = /** @type {const} */ ([
  "supervisor",
  "backup",
  "scope_approver",
]);
export const COVERAGE_PLAN_OUTLET_FREQUENCY = /** @type {const} */ ([
  "weekly",
  "biweekly",
  "monthly",
  "custom",
]);
export const COVERAGE_PLAN_OUTLET_PREFERRED_WEEKDAY = /** @type {const} */ ([
  0, 1, 2, 3, 4, 5, 6,
]);
export const COVERAGE_PLAN_SLOT_KIND = /** @type {const} */ ([
  "outlet_visit",
  "non_visit",
]);
export const POSITION_ROUTINE_TEMPLATE_WEEKDAY = /** @type {const} */ ([
  0, 1, 2, 3, 4, 5, 6,
]);
export const POSITION_ROUTINE_TEMPLATE_DAY_KIND = /** @type {const} */ ([
  "selling",
  "field",
  "admin",
  "day_off",
]);
export const POSITION_ROUTINE_TEMPLATE_ACTIVITY_KIND = /** @type {const} */ ([
  "outlet_visit",
  "non_visit",
]);
export const PLANNED_VISIT_STATUS = /** @type {const} */ ([
  "planned",
  "cancelled",
  "replaced",
]);

/**
 * `coverage_plans`
 * @typedef {Object} CoveragePlanRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} assigneeProfileId
 * @property {string} localMonth
 * @property {number} version
 * @property {"monthly"} cycleType
 * @property {string} orgUnitId
 * @property {Date} requestedFrom
 * @property {Date} requestedTo
 * @property {Date} effectiveFrom
 * @property {Date} effectiveTo
 * @property {"draft" | "submitted" | "approved" | "active" | "superseded"} status
 * @property {string | null} basedOnPlanId
 * @property {string | null} revisionReason
 * @property {string} preparedBy
 * @property {Date} preparedAt
 * @property {string | null} submittedBy
 * @property {Date | null} submittedAt
 * @property {string | null} approvedBy
 * @property {Date | null} approvedAt
 * @property {string | null} approvalSignature
 * @property {string | null} approverProfileId
 * @property {"supervisor" | "backup" | "scope_approver" | null} approvalCapacity
 * @property {string | null} approvedOnBehalfOfProfileId
 * @property {Date | null} activatedAt
 * @property {Date | null} supersededAt
 * @property {Date | null} activeThrough
 * @property {number} contentRevision
 * @property {string | null} contentHash
 * @property {string} createdBy
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `coverage_plan_territories` (child of `coverage_plans`)
 * @typedef {Object} CoveragePlanTerritoryRow
 * @property {string} id
 * @property {string} coveragePlanId
 * @property {number} ordinal
 * @property {string} territoryId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `coverage_assignments`
 * @typedef {Object} CoverageAssignmentRow
 * @property {string} id
 * @property {string} planId
 * @property {string} assigneeProfileId
 * @property {string} orgUnitId
 * @property {boolean} isPrimary
 * @property {Date} effectiveFrom
 * @property {Date} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `coverage_plan_outlets`
 * @typedef {Object} CoveragePlanOutletRow
 * @property {string} id
 * @property {string} planId
 * @property {string} outletId
 * @property {string | null} routeId
 * @property {string} territoryId
 * @property {"weekly" | "biweekly" | "monthly" | "custom"} frequency
 * @property {Date | null} anchorLocalDate
 * @property {number | null} weekOrdinal
 * @property {number[]} preferredWeekdays
 * @property {Date[]} customLocalDates
 * @property {number | null} sequence
 * @property {number} priority
 * @property {number} expectedDurationMinutes
 * @property {string[]} requiredObjectives
 * @property {string | null} visitWindow
 * @property {number} contentRevision
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `coverage_plan_slots`
 * @typedef {Object} CoveragePlanSlotRow
 * @property {string} id
 * @property {string} slotKey
 * @property {string} planId
 * @property {string} assigneeProfileId
 * @property {Date} serviceDate
 * @property {"outlet_visit" | "non_visit"} kind
 * @property {string | null} outletId
 * @property {string | null} routeId
 * @property {string | null} activityKind
 * @property {string | null} namedTruckRef
 * @property {string[]} requiredObjectives
 * @property {string[]} intents
 * @property {number} sequence
 * @property {number} expectedDurationMinutes
 * @property {Record<string, unknown> | null} approvedSnapshot
 * @property {number} contentRevision
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `position_routine_templates`
 * @typedef {Object} PositionRoutineTemplateRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} positionId
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {0 | 1 | 2 | 3 | 4 | 5 | 6} weekday
 * @property {"selling" | "field" | "admin" | "day_off"} dayKind
 * @property {string} sourceRef
 * @property {boolean} provisional
 * @property {string} actorSubject
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `position_routine_template_activities` (child of `position_routine_templates`)
 * @typedef {Object} PositionRoutineTemplateActivityRow
 * @property {string} id
 * @property {string} positionRoutineTemplateId
 * @property {number} ordinal
 * @property {number} sequence
 * @property {string} name
 * @property {"outlet_visit" | "non_visit"} kind
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `planned_visits`
 * @typedef {Object} PlannedVisitRow
 * @property {string} id
 * @property {string} generationKey
 * @property {string} planId
 * @property {number} planVersion
 * @property {string} planSlotId
 * @property {string} assigneeProfileId
 * @property {string} outletId
 * @property {Date} serviceDate
 * @property {"planned" | "cancelled" | "replaced"} status
 * @property {Record<string, unknown>} approvedSnapshot
 * @property {string[]} requiredObjectives
 * @property {string[]} intents
 * @property {number} expectedDurationMinutes
 * @property {Date} generatedAt
 * @property {string | null} replacedByVisitId
 * @property {string | null} replacementOfVisitId
 * @property {string | null} cancellationReason
 * @property {Date | null} cancelledAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `supervisor_away_periods`
 * @typedef {Object} SupervisorAwayPeriodRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} profileId
 * @property {Date} effectiveFrom
 * @property {Date} effectiveTo
 * @property {string} reason
 * @property {string} recordedBy
 * @property {Date} recordedAt
 * @property {string | null} endedBy
 * @property {Date | null} endedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `coverage_audit_events`
 * @typedef {Object} CoverageAuditEventRow
 * @property {string} id
 * @property {string} planId
 * @property {string} assigneeProfileId
 * @property {string} orgUnitId
 * @property {string} localMonth
 * @property {string} actorSubject
 * @property {string} action
 * @property {string | null} reason
 * @property {string} affectedEntity
 * @property {string | null} affectedRowId
 * @property {unknown | null} before
 * @property {unknown | null} after
 * @property {unknown | null} diff
 * @property {number} planVersion
 * @property {string | null} approvalSignatureRef
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
