// @ts-check
/**
 * CSV/XLSX import runs. Row shapes for migration 0115_imports.sql.
 * Tables: import_runs, import_run_locations, import_run_errors.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const IMPORT_RUN_IMPORT_TYPE = /** @type {const} */ (["products", "opening_stock", "stock_adjustment", "cycle_count", "mcp"]);
export const IMPORT_RUN_STATUS = /** @type {const} */ (["previewed", "committing", "completed", "failed", "submitted"]);

/**
 * `import_runs` (Convex `importRuns`)
 * @typedef {Object} ImportRunRow
 * @property {string} id
 * @property {string} organizationId
 * @property {"products" | "opening_stock" | "stock_adjustment" | "cycle_count" | "mcp"} importType
 * @property {string | null} mcpPlanId
 * @property {string} runKey
 * @property {number} chunkIndex
 * @property {string} fileHash
 * @property {string | null} chunkHash
 * @property {string} idempotencyKey
 * @property {string} actorSubject
 * @property {"previewed" | "committing" | "completed" | "failed" | "submitted"} status
 * @property {string | null} sourceReference
 * @property {string[]} rowKeys
 * @property {string | null} adjustmentType
 * @property {string | null} reasonCode
 * @property {string | null} adjustmentId
 * @property {string | null} sessionId
 * @property {number} rowCount
 * @property {number | null} fileRowCount
 * @property {number} createdCount
 * @property {number} updatedCount
 * @property {number} skippedCount
 * @property {number} failedCount
 * @property {string | null} movementId
 * @property {Date | null} completedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `import_run_locations` (Convex `importRuns`, child of `import_runs`)
 * @typedef {Object} ImportRunLocationRow
 * @property {string} id
 * @property {string} importRunId
 * @property {number} ordinal
 * @property {string} locationId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `import_run_errors` (Convex `importRunErrors`)
 * @typedef {Object} ImportRunErrorRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} runId
 * @property {number} rowNumber
 * @property {string | null} columnName
 * @property {string} code
 * @property {string} message
 * @property {string} rawRow
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
