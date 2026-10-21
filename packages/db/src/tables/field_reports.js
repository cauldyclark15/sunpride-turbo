// @ts-check
/**
 * DAR / ROAR field day reports. Row shapes for migration 0113_field_reports.sql.
 * Tables: field_day_reports.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const FIELD_DAY_REPORT_KIND = /** @type {const} */ (["dar", "roar"]);

/**
 * `field_day_reports`
 * @typedef {Object} FieldDayReportRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} profileId
 * @property {string} orgUnitId
 * @property {Date} serviceDate
 * @property {"dar" | "roar"} kind
 * @property {number} revision
 * @property {string} remarks
 * @property {Record<string, unknown>} summary
 * @property {string} submittedBy
 * @property {Date} submittedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
