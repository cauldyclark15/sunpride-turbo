// @ts-check
/**
 * Work-with, per diem, talk sheets, trainer forms. Row shapes for migration 0112_supervision.sql.
 * Tables: work_with_sessions, work_with_session_observations, per_diem_validations, talk_sheets, talk_sheet_items, trainer_forms, trainer_form_evaluation_sessions.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const WORK_WITH_SESSION_OBJECTIVE = /** @type {const} */ (["training", "sales_validation"]);
export const WORK_WITH_SESSION_MODE = /** @type {const} */ (["booking", "truck"]);
export const WORK_WITH_SESSION_STATUS = /** @type {const} */ (["open", "completed", "cancelled"]);
export const WORK_WITH_SESSION_PRE_CALL_DOCUMENT = /** @type {const} */ (["distribution", "productivity", "daily_productive_sales_report", "call_sheet"]);
export const WORK_WITH_SESSION_OBSERVATION_AREA = /** @type {const} */ (["bcp", "psf"]);
export const WORK_WITH_SESSION_OBSERVATION_RATING = /** @type {const} */ (["met", "partial", "not_met"]);
export const PER_DIEM_VALIDATION_DECISION = /** @type {const} */ (["validated", "returned"]);
export const TALK_SHEET_STATUS = /** @type {const} */ (["draft", "final"]);
export const TALK_SHEET_ITEM_TOPIC = /** @type {const} */ (["siv_stt", "buying_accounts", "program_utilization", "report_submission", "inventory_days", "marketing_program", "other_operational"]);
export const TALK_SHEET_ITEM_STATUS = /** @type {const} */ (["completed", "on_going", "overdue"]);
export const TRAINER_FORM_KIND = /** @type {const} */ (["training_program", "training_sheet", "job_evaluation"]);
export const TRAINER_FORM_STATUS = /** @type {const} */ (["draft", "signed", "acknowledged"]);

/**
 * `work_with_sessions` (Convex `workWithSessions`)
 * @typedef {Object} WorkWithSessionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} trainerProfileId
 * @property {string | null} trainerPositionId
 * @property {string} traineeProfileId
 * @property {string} orgUnitId
 * @property {Date} serviceDate
 * @property {"training" | "sales_validation"} objective
 * @property {"booking" | "truck"} mode
 * @property {string | null} truckReference
 * @property {boolean | null} rodeWithTruck
 * @property {"open" | "completed" | "cancelled"} status
 * @property {string | null} trainingLogTopics
 * @property {string | null} trainingLogTradeDevelopment
 * @property {boolean | null} trainingLogDiscussedWithTrainee
 * @property {Array<"distribution" | "productivity" | "daily_productive_sales_report" | "call_sheet">} preCallDocuments
 * @property {string | null} preCallRemarks
 * @property {string | null} postCallStrengths
 * @property {string | null} postCallWeaknesses
 * @property {string | null} postCallOpportunities
 * @property {string | null} postCallThreats
 * @property {number | null} mcpPlanned
 * @property {number | null} mcpDone
 * @property {Date | null} completedAt
 * @property {Date | null} cancelledAt
 * @property {string | null} cancelReason
 * @property {string} createdBy
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `work_with_session_observations` (Convex `workWithSessions`, child of `work_with_sessions`)
 * @typedef {Object} WorkWithSessionObservationRow
 * @property {string} id
 * @property {string} workWithSessionId
 * @property {number} ordinal
 * @property {"bcp" | "psf"} area
 * @property {string} item
 * @property {"met" | "partial" | "not_met"} rating
 * @property {string | null} remark
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `per_diem_validations` (Convex `perDiemValidations`)
 * @typedef {Object} PerDiemValidationRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} profileId
 * @property {string} orgUnitId
 * @property {string} localMonth
 * @property {Date} periodFrom
 * @property {Date} periodTo
 * @property {"validated" | "returned"} decision
 * @property {string | null} note
 * @property {string} contentHash
 * @property {string} ruleVersion
 * @property {number} plannedStops
 * @property {number} validCalls
 * @property {number} invalidCalls
 * @property {number} notVisited
 * @property {number} validDays
 * @property {Date[]} validDates
 * @property {string} decidedBy
 * @property {string} deciderProfileId
 * @property {Date} decidedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `talk_sheets` (Convex `talkSheets`)
 * @typedef {Object} TalkSheetRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} partnerName
 * @property {string} partnerKey
 * @property {string} ownerProfileId
 * @property {Date} meetingDate
 * @property {Date | null} nextContactDate
 * @property {string | null} acknowledgedByName
 * @property {"draft" | "final"} status
 * @property {string | null} previousSheetId
 * @property {Date | null} finalizedAt
 * @property {string} createdBy
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `talk_sheet_items` (Convex `talkSheetItems`)
 * @typedef {Object} TalkSheetItemRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} sheetId
 * @property {number} position
 * @property {"siv_stt" | "buying_accounts" | "program_utilization" | "report_submission" | "inventory_days" | "marketing_program" | "other_operational"} topic
 * @property {string} gap
 * @property {string} agreement
 * @property {string} correctiveAction
 * @property {string} responsible
 * @property {string} timeline
 * @property {"completed" | "on_going" | "overdue"} status
 * @property {string | null} rootCause
 * @property {Date} openedOn
 * @property {string | null} originItemId
 * @property {string | null} carriedFromItemId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `trainer_forms` (Convex `trainerForms`)
 * @typedef {Object} TrainerFormRow
 * @property {string} id
 * @property {string} organizationId
 * @property {"training_program" | "training_sheet" | "job_evaluation"} kind
 * @property {string} sessionId
 * @property {string} trainerProfileId
 * @property {string} traineeProfileId
 * @property {string} orgUnitId
 * @property {Date} serviceDate
 * @property {"draft" | "signed" | "acknowledged"} status
 * @property {Record<string, unknown> | null} program
 * @property {Record<string, unknown> | null} sheet
 * @property {Record<string, unknown> | null} evaluation
 * @property {Date | null} signedAt
 * @property {string | null} signedBy
 * @property {Date | null} acknowledgedAt
 * @property {string | null} acknowledgedBy
 * @property {string | null} traineeComment
 * @property {string} createdBy
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `trainer_form_evaluation_sessions` (Convex `trainerForms`, child of `trainer_forms`)
 * @typedef {Object} TrainerFormEvaluationSessionRow
 * @property {string} id
 * @property {string} trainerFormId
 * @property {number} ordinal
 * @property {string} sessionId
 * @property {Date} serviceDate
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
