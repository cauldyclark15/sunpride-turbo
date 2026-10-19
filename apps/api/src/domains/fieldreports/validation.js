import { ApiError } from "../../core/errors.js";

/** @param {string} message @param {number} [status] @param {string} [code] @returns {never} */
export function fail(message, status = 422, code = "invalid_request") {
  throw new ApiError(code, status, message);
}
/** @param {any} value @param {string} [label] */
export function uuid(value, label = "Identifier") {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    fail(`${label} is invalid`, 400);
  return value;
}
/** @param {any} value */
export function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    fail("Use a valid date", 400);
  return /** @type {string} */ (value);
}
/** @param {any} value @param {number} [max] */
export function text(value, max = 2000) {
  if (typeof value !== "string" || value.length > max)
    fail("Text is missing or too long", 400);
  return value.trim();
}
/** @param {any} value @param {readonly string[]} values */
export function oneOf(value, values) {
  if (!values.includes(value)) fail("Choose a supported value", 400);
  return value;
}
/** @param {any} value */
export function day(value) {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}
/** @param {any} value */
export function ms(value) {
  return value == null ? null : new Date(value).getTime();
}
/** @param {number} [now] */
export function today(now = Date.now()) {
  return new Date(now + 28800000).toISOString().slice(0, 10);
}
/** @param {string} d @param {number} n */
export function addDays(d, n) {
  return new Date(Date.parse(date(d) + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
}
/** @param {string} d */
export function noon(d) {
  return new Date(date(d) + "T12:00:00+08:00");
}
/** @param {string} from @param {string} to @param {number} [max] */
export function dates(from, to, max = 31) {
  date(from);
  date(to);
  const count = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (count < 1 || count > max)
    fail(`Choose a period of at most ${max} days`, 400);
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}
/** @param {any} value */
export function hash(value) {
  /** @returns {any} */
  const canonical = (/** @type {any} */ v) => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical(v[k])]),
      );
    return v;
  };
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** @param {any} row @returns {Record<string,any>} */
export function dto(row) {
  const out = /** @type {Record<string,any>} */ ({});
  for (const [k, v] of Object.entries(row)) {
    if (v === null) continue;
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] =
      v instanceof Date
        ? /_date$|_on$|^timeline$/.test(k)
          ? day(v)
          : ms(v)
        : v;
  }
  return { ...out, _id: row.id, _creationTime: ms(row.created_at) };
}
