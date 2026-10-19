import { ApiError } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";

export const ORGANIZATION = "sunpride";
export const MAX_CENTAVOS = 99_999_999_999_999;
/** Exact legacy numeric(14,2) mirror; never use float money for a database write. @param {number} value */
export function decimalMoney(value) {
  const n = BigInt(integer(value, "Amount", MAX_CENTAVOS));
  return `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}
/** @param {string} message @param {string} [code] */
export function fail(message, code = "invalid_request") {
  throw new ApiError(code, 422, message);
}
/** @param {any} v @param {string} label @param {number} [max] */
export function text(v, label, max = 500) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail(`${label} is required (up to ${max} characters)`);
  return v.trim();
}
/** @param {any} v @param {string} [label] */
export function uuid(v, label = "Reference") {
  if (!isUuid(v)) fail(`${label} is invalid`);
  return /** @type {string} */ (v);
}
/** @param {any} v @param {string} [label] @param {number} [max] */
export function integer(v, label = "Amount", max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max)
    fail(`${label} must be a nonnegative whole number`);
  return /** @type {number} */ (v);
}
/** @param {any} value */
export function instant(value) {
  const n =
    typeof value === "number" ||
    (typeof value === "string" && /^\d{10,16}$/.test(value))
      ? Number(value)
      : Date.parse(value);
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    !Number.isFinite(new Date(n).getTime())
  )
    fail("Effective date is invalid");
  return new Date(n);
}
/** @param {number|Date} at */
export const manilaDate = (at) =>
  new Date(Number(at) + 8 * 3600_000).toISOString().slice(0, 10);
/** @param {any} s */
export function date(s) {
  if (
    typeof s !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(`${s}T00:00:00Z`)) ||
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s
  )
    fail("Choose a real Manila date");
  return s;
}
/** @param {any} v @returns {bigint} Thousandths of a selling unit, exact to the schema precision. */
export function quantityMilli(v) {
  const s = String(v);
  if (!/^\d+(\.\d{1,3})?$/.test(s))
    fail("Quantity must be positive with at most three decimal places");
  const [whole = "0", decimals = ""] = s.split(".");
  const n = BigInt(whole) * 1000n + BigInt(decimals.padEnd(3, "0"));
  if (n <= 0n || n > 1_000_000_000n)
    fail("Quantity must be between zero and one million units");
  return n;
}
/** @param {bigint} n */
export function safe(n) {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) fail("Amount is too large");
  return value;
}
/** Positive money, half-up at the centavo. @param {bigint} n @param {bigint} d */
export const divide = (n, d) => (n + d / 2n) / d;
/** @param {any} v @param {readonly string[]} values @param {string} label */
export function choice(v, values, label) {
  if (!values.includes(v)) fail(`${label} is invalid`);
  return /** @type {string} */ (v);
}
/** @param {any} v */
export const channel = (v) =>
  typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
/** @param {any} value */
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
/** @param {any[][]} rows */
export function csv(rows) {
  return new Response(
    "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"),
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="orders.csv"',
      },
    },
  );
}
