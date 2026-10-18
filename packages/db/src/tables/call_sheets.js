// @ts-check
/**
 * Call sheets. Row shapes for migration 0111_call_sheets.sql.
 * Tables: call_sheet_accounts, call_sheet_account_lines, call_sheet_account_revisions, call_sheet_account_revision_products, call_sheet_entries.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */


/**
 * `call_sheet_accounts` (Convex `callSheetAccounts`)
 * @typedef {Object} CallSheetAccountRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} outletId
 * @property {number} revision
 * @property {string} headerAccountName
 * @property {string | null} headerAddress
 * @property {string | null} headerBuyerName
 * @property {string | null} headerContactNumber
 * @property {string | null} headerAccountInCharge
 * @property {string | null} headerReceivingInCharge
 * @property {string | null} headerDistributorName
 * @property {string | null} headerDistributorSchedule
 * @property {string | null} headerFoc
 * @property {string | null} headerPricing
 * @property {string} updatedBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `call_sheet_account_lines` (Convex `callSheetAccounts`, child of `call_sheet_accounts`)
 * @typedef {Object} CallSheetAccountLineRow
 * @property {string} id
 * @property {string} callSheetAccountId
 * @property {number} ordinal
 * @property {string} productId
 * @property {string | null} pricing
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `call_sheet_account_revisions` (Convex `callSheetAccountRevisions`)
 * @typedef {Object} CallSheetAccountRevisionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} outletId
 * @property {number} revision
 * @property {Date} effectiveFrom
 * @property {Date} supersededAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `call_sheet_account_revision_products` (Convex `callSheetAccountRevisions`, child of `call_sheet_account_revisions`)
 * @typedef {Object} CallSheetAccountRevisionProductRow
 * @property {string} id
 * @property {string} callSheetAccountRevisionId
 * @property {number} ordinal
 * @property {string} productId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `call_sheet_entries` (Convex `callSheetEntries`)
 * @typedef {Object} CallSheetEntryRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} outletId
 * @property {string} visitId
 * @property {string} activityId
 * @property {string} assigneeProfileId
 * @property {Date} serviceDate
 * @property {string} localMonth
 * @property {number} week
 * @property {string} productId
 * @property {number} templateRevision
 * @property {number | null} orderQty
 * @property {number | null} beginningInventory
 * @property {number | null} take
 * @property {number | null} delivered
 * @property {number | null} offtake
 * @property {number | null} endInventory
 * @property {Date} serverTime
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

export {};
