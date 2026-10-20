import { ApiError } from "../../core/errors.js";
import { createHash } from "node:crypto";
import { MIGRATION_HEADERS } from "./migration-headers.js";

export const ORGANIZATION = "sunpride";
export const HEADERS = {
  ...MIGRATION_HEADERS,
  products:
    "product_code,name,category,base_uom,selling_uoms,barcode,tracking_mode,allocation_policy,shelf_life_days,expiry_required,manufacture_date_required,minimum_remaining_shelf_life_days,external_id",
  opening_stock:
    "product_code,location_code,lot_number,manufactured_at,expires_at,quantity,unit_cost_minor,source_reference",
  stock_adjustment:
    "source_reference,line_key,adjustment_type,reason_code,product_code,location_code,stock_status,lot_number,quantity_delta,unit_cost_minor,note",
  cycle_count:
    "count_reference,location_code,product_code,stock_status,lot_number,counted_quantity,finding,note",
  mcp_visits:
    "employee_code,territory_code,route_code,outlet_code,customer_code,service_date,frequency,sequence,duration_minutes,objectives",
  route_sheet:
    "employee_code,territory_code,route_code,outlet_code,customer_code,frequency,sequence,duration_minutes,objectives",
};
/** @typedef {{rowNumber:number,values:Record<string,string>}} Row */
/** @typedef {{rowNumber:number,column?:string,code:string,message:string}} RowError */
/** @param {Row} row @param {string} key */
export const cell = (row, key) => (row.values[key] ?? "").trim();
/** @param {number} rowNumber @param {string} code @param {string} message @param {string} [column] */
export const error = (rowNumber, code, message, column) => ({
  rowNumber,
  code,
  message,
  ...(column ? { column } : {}),
});
/** @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
/** Hash every posting input, not the caller's claimed file hash. @param {any} input */
export const chunkHashOf = (input) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
/** @param {string} kind @param {any} input @param {boolean} commit */
export function checkInput(kind, input, commit) {
  const key = kind === "mcp" ? input?.format : kind;
  const expected = HEADERS[/** @type {keyof typeof HEADERS} */ (key)];
  if (
    !expected ||
    !Array.isArray(input?.header) ||
    input.header.join(",") !== expected ||
    input.header.length !== expected.split(",").length
  )
    throw new ApiError(
      "invalid_format",
      400,
      "Columns must match the downloaded template, in the same order.",
    );
  if (
    !Array.isArray(input.rows) ||
    !input.rows.length ||
    input.rows.length > (commit ? 100 : 5000)
  )
    throw new ApiError(
      "too_many_rows",
      400,
      "Use 1–5,000 rows per file and no more than 100 per submission.",
    );
  const numbers = new Set();
  for (const row of input.rows) {
    if (
      !Number.isSafeInteger(row?.rowNumber) ||
      row.rowNumber < 2 ||
      numbers.has(row.rowNumber) ||
      !row.values ||
      Array.isArray(row.values) ||
      typeof row.values !== "object" ||
      Object.entries(row.values).some(
        ([key, value]) =>
          !input.header.includes(key) ||
          typeof value !== "string" ||
          value.length > 500,
      )
    )
      throw new ApiError(
        "invalid_format",
        400,
        "Each row needs a unique spreadsheet row number and text cells from the template.",
      );
    numbers.add(row.rowNumber);
  }
  if (
    commit &&
    (!Number.isSafeInteger(input.chunkIndex) ||
      input.chunkIndex < 0 ||
      !Number.isSafeInteger(input.rowCount) ||
      input.rowCount < input.rows.length ||
      input.rowCount > 5000 ||
      input.chunkIndex >= input.rowCount ||
      typeof input.runKey !== "string" ||
      !input.runKey.trim() ||
      input.runKey.length > 200 ||
      typeof input.fileHash !== "string" ||
      !input.fileHash.trim() ||
      input.fileHash.length > 150 ||
      input.idempotencyKey !== `${kind}:${input.runKey}:${input.chunkIndex}`)
  )
    throw new ApiError(
      "invalid_format",
      400,
      "The file identity or chunk number is invalid.",
    );
  if (
    commit &&
    kind !== "cycle_count" &&
    (input.chunkIndex >= Math.ceil(input.rowCount / 100) ||
      input.rows.length !==
        Math.min(100, input.rowCount - input.chunkIndex * 100))
  )
    throw new ApiError(
      "invalid_format",
      400,
      "Submit consecutive chunks of 100 rows, with only the final chunk shorter.",
    );
}
/** Exact decimal conversion using the product's scale. @param {string} text @param {number|string} scale */
export function quantity(text, scale) {
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
  const divisor = 10n ** BigInt(fraction.length);
  const scaled = BigInt(whole + fraction) * BigInt(scale);
  if (scaled % divisor) return null;
  const value = Number(scaled / divisor) * (text.startsWith("-") ? -1 : 1);
  return Number.isSafeInteger(value) ? value : null;
}
/** @param {string} value */
export function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
}
/** Sessions must never be divided, including noncontiguous rows. @param {Row[]} rows */
export function countChunks(rows) {
  /** @type {Map<string,Row[]>} */
  const groups = new Map();
  for (const row of rows) {
    const key = cell(row, "count_reference");
    if (!key)
      throw new ApiError(
        "invalid_format",
        400,
        "Every count row needs its count reference.",
      );
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    if (group.length > 100)
      throw new ApiError(
        "session_too_large",
        400,
        "A count session cannot exceed 100 rows or be split across submissions.",
      );
  }
  return [...groups.values()];
}
