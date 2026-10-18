// @ts-check
/**
 * Org units, positions, people/profiles, teams, audit log. Row shapes for migration 0100_org.sql.
 * Tables: org_unit_types, org_units, org_unit_parent_edges, positions, position_standards, profiles, access_invitations, employee_assignments, teams, team_memberships, audit_logs.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const ORG_UNIT_STATUS = /** @type {const} */ (["active", "inactive"]);
export const POSITION_CATEGORY = /** @type {const} */ (["leadership", "supervisory", "specialist", "field", "support"]);
export const POSITION_STANDARD_PRODUCTIVE_CALL_RULE = /** @type {const} */ (["any_listed_activity", "truck_seller"]);
export const PROFILE_ROLE = /** @type {const} */ (["super_admin", "admin", "operations", "manager", "approver", "sales", "analyst", "viewer"]);
export const PROFILE_STATUS = /** @type {const} */ (["active", "disabled"]);
export const PROFILE_EMPLOYMENT_TYPE = /** @type {const} */ (["sfi_employee", "adp_personnel", "third_party"]);
export const ACCESS_INVITATION_ROLE = /** @type {const} */ (["super_admin", "admin", "operations", "manager", "approver", "sales", "analyst", "viewer"]);
export const ACCESS_INVITATION_STATUS = /** @type {const} */ (["pending", "accepted", "revoked"]);
export const EMPLOYEE_ASSIGNMENT_ROLE = /** @type {const} */ (["super_admin", "admin", "operations", "manager", "approver", "sales", "analyst", "viewer"]);
export const TEAM_STATUS = /** @type {const} */ (["active", "inactive"]);

/**
 * `org_unit_types` (Convex `orgUnitTypes`)
 * @typedef {Object} OrgUnitTypeRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} label
 * @property {number} level
 * @property {boolean} active
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `org_units` (Convex `orgUnits`)
 * @typedef {Object} OrgUnitRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} name
 * @property {string} typeCode
 * @property {string | null} parentId
 * @property {"active" | "inactive"} status
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string | null} externalId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `org_unit_parent_edges` (Convex `orgUnitParentEdges`)
 * @typedef {Object} OrgUnitParentEdgeRow
 * @property {string} id
 * @property {string} unitId
 * @property {string} parentId
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
 * `positions` (Convex `positions`)
 * @typedef {Object} PositionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} label
 * @property {"leadership" | "supervisory" | "specialist" | "field" | "support"} category
 * @property {boolean} active
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `position_standards` (Convex `positionStandards`)
 * @typedef {Object} PositionStandardRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} positionId
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {number | null} dailyCallsTarget
 * @property {number | null} productiveCallTargetPct
 * @property {number | null} workWithWeeklyMin
 * @property {number | null} workWithMonthlyMin
 * @property {"any_listed_activity" | "truck_seller" | null} productiveCallRule
 * @property {number[]} sellingWeekdays
 * @property {string | null} notes
 * @property {string} sourceRef
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `profiles` (Convex `profiles`)
 * @typedef {Object} ProfileRow
 * @property {string} id
 * @property {string | null} userId
 * @property {string | null} authSubject
 * @property {string} name
 * @property {string} email
 * @property {"super_admin" | "admin" | "operations" | "manager" | "approver" | "sales" | "analyst" | "viewer"} role
 * @property {"active" | "disabled"} status
 * @property {string | null} orgUnitId
 * @property {string | null} employeeCode
 * @property {string | null} positionId
 * @property {"sfi_employee" | "adp_personnel" | "third_party" | null} employmentType
 * @property {string | null} channelScope
 * @property {string | null} supervisorSubject
 * @property {Date | null} effectiveFrom
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `access_invitations` (Convex `accessInvitations`)
 * @typedef {Object} AccessInvitationRow
 * @property {string} id
 * @property {string} email
 * @property {string | null} name
 * @property {"super_admin" | "admin" | "operations" | "manager" | "approver" | "sales" | "analyst" | "viewer"} role
 * @property {string | null} positionId
 * @property {"pending" | "accepted" | "revoked"} status
 * @property {string} invitedBy
 * @property {Date} invitedAt
 * @property {Date | null} acceptedAt
 * @property {string | null} profileId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `employee_assignments` (Convex `employeeAssignments`)
 * @typedef {Object} EmployeeAssignmentRow
 * @property {string} id
 * @property {string} profileId
 * @property {string | null} orgUnitId
 * @property {"super_admin" | "admin" | "operations" | "manager" | "approver" | "sales" | "analyst" | "viewer"} role
 * @property {string | null} positionId
 * @property {string | null} supervisorId
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
 * `teams` (Convex `teams`)
 * @typedef {Object} TeamRow
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {string} orgUnitId
 * @property {"active" | "inactive"} status
 * @property {string | null} supervisorProfileId
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `team_memberships` (Convex `teamMemberships`)
 * @typedef {Object} TeamMembershipRow
 * @property {string} id
 * @property {string} teamId
 * @property {string} profileId
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `audit_logs` (Convex `auditLogs`)
 * @typedef {Object} AuditLogRow
 * @property {string} id
 * @property {string} subject
 * @property {string} action
 * @property {string} entityType
 * @property {string} entityId
 * @property {string | null} details
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
