// @ts-check
/**
 * Beta sample-data markers. Row shapes for migration 0118_beta.sql.
 * Tables: sample_data_rows, sample_data_changes.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const SAMPLE_DATA_CHANGE_KIND = /** @type {const} */ ([
  "customer_credit_limit",
]);

/**
 * `sample_data_rows`
 * @typedef {Object} SampleDataRowRow
 * @property {string} id
 * @property {string} batch
 * @property {string} tableName
 * @property {string} rowId
 * @property {string} key
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `sample_data_changes`
 * @typedef {Object} SampleDataChangeRow
 * @property {string} id
 * @property {string} organizationId
 * @property {"customer_credit_limit"} kind
 * @property {string} customerId
 * @property {number} previousValue
 * @property {number} sampleValue
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
