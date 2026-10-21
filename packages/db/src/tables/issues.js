// @ts-check
/**
 * Issue board. Row shapes for migration 0117_issues.sql.
 * Tables: issues, issue_comments, issue_attachments, issue_activity, issue_counters.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const ISSUE_PRIORITY = /** @type {const} */ ([
  "low",
  "medium",
  "high",
  "critical",
]);
export const ISSUE_STATUS = /** @type {const} */ ([
  "draft",
  "ongoing_test",
  "need_to_rectify",
  "awaiting_client_response",
  "dev_work_ongoing",
  "for_retest",
  "completed",
]);
export const ISSUE_ACTIVITY_KIND = /** @type {const} */ ([
  "created",
  "updated",
  "status_changed",
  "commented",
  "comment_updated",
  "comment_deleted",
  "attachment_removed",
  "archived",
  "restored",
]);
export const ISSUE_ACTIVITY_FROM_STATUS = /** @type {const} */ ([
  "draft",
  "ongoing_test",
  "need_to_rectify",
  "awaiting_client_response",
  "dev_work_ongoing",
  "for_retest",
  "completed",
]);
export const ISSUE_ACTIVITY_TO_STATUS = /** @type {const} */ ([
  "draft",
  "ongoing_test",
  "need_to_rectify",
  "awaiting_client_response",
  "dev_work_ongoing",
  "for_retest",
  "completed",
]);

/**
 * `issues`
 * @typedef {Object} IssueRow
 * @property {string} id
 * @property {number} number
 * @property {string} title
 * @property {string | null} description
 * @property {string | null} steps
 * @property {string | null} actual
 * @property {string | null} expected
 * @property {string} area
 * @property {"low" | "medium" | "high" | "critical"} priority
 * @property {"draft" | "ongoing_test" | "need_to_rectify" | "awaiting_client_response" | "dev_work_ongoing" | "for_retest" | "completed"} status
 * @property {number} sortOrder
 * @property {string | null} assigneeId
 * @property {string | null} reporterId
 * @property {string | null} reporterLabel
 * @property {string | null} externalRef
 * @property {string | null} milestone
 * @property {boolean} archived
 * @property {Date | null} archivedAt
 * @property {string} searchText
 * @property {number} commentCount
 * @property {number} attachmentCount
 * @property {Date | null} lastCommentAt
 * @property {string | null} lastCommentAuthorId
 * @property {string | null} lastCommentAuthorLabel
 * @property {string | null} updatedBy
 * @property {string | null} searchTsv
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `issue_comments`
 * @typedef {Object} IssueCommentRow
 * @property {string} id
 * @property {string} issueId
 * @property {string | null} authorId
 * @property {string | null} authorLabel
 * @property {string} body
 * @property {Date | null} deletedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `issue_attachments`
 * @typedef {Object} IssueAttachmentRow
 * @property {string} id
 * @property {string} issueId
 * @property {string} commentId
 * @property {string} storageId
 * @property {string} fileName
 * @property {string} fileType
 * @property {string} fileSize
 * @property {string | null} uploadedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `issue_activity`
 * @typedef {Object} IssueActivityRow
 * @property {string} id
 * @property {string} issueId
 * @property {string | null} actorId
 * @property {string | null} actorLabel
 * @property {"created" | "updated" | "status_changed" | "commented" | "comment_updated" | "comment_deleted" | "attachment_removed" | "archived" | "restored"} kind
 * @property {"draft" | "ongoing_test" | "need_to_rectify" | "awaiting_client_response" | "dev_work_ongoing" | "for_retest" | "completed" | null} fromStatus
 * @property {"draft" | "ongoing_test" | "need_to_rectify" | "awaiting_client_response" | "dev_work_ongoing" | "for_retest" | "completed" | null} toStatus
 * @property {Record<string, unknown> | null} changes
 * @property {string | null} note
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `issue_counters`
 * @typedef {Object} IssueCounterRow
 * @property {string} id
 * @property {string} key
 * @property {number} lastNumber
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
