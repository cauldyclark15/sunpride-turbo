import { ApiError, invalid } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";

export const VOID_REASONS = [
  "wrong_items",
  "wrong_quantity",
  "wrong_customer",
  "wrong_payment",
  "customer_cancelled",
  "other",
];
export const CASH_VARIANCE_REASONS = [
  "counting_error",
  "change_error",
  "customer_short_paid",
  "customer_overpaid",
  "lost_or_stolen",
  "counterfeit",
  "other",
];
export const STOCK_VARIANCE_REASONS = [
  "missing",
  "extra_found",
  "damaged_not_recorded",
  "sale_or_return_not_recorded",
  "free_goods_or_sample",
  "loading_error",
  "other",
];
export const DAMAGE_REASONS = [
  "crushed",
  "leaking",
  "expired",
  "spoiled",
  "other",
];
export const LOAD_REASONS = [
  "short_loaded",
  "over_loaded",
  "damaged_at_loading",
  "wrong_item",
  "other",
];
export const PAYMENT_METHODS = [
  {
    code: "cash",
    label: "Cash",
    kind: "cash",
    referenceRequired: false,
    referenceLabel: null,
  },
  {
    code: "check",
    label: "Cheque",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "Check number",
  },
  {
    code: "gcash",
    label: "GCash",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "GCash reference number",
  },
  {
    code: "maya",
    label: "Maya",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "Maya confirmation reference",
  },
  {
    code: "card",
    label: "Card",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "Terminal approval (never card number)",
  },
  {
    code: "bank_transfer",
    label: "Bank transfer",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "Bank reference number",
  },
  {
    code: "credit",
    label: "Credit (charge to account)",
    kind: "credit",
    referenceRequired: false,
    referenceLabel: null,
  },
];
export const DAMAGE_POLICY = {
  photoRequiredReasons: ["crushed", "leaking", "spoiled", "other"],
  approvalFromUnits: 12,
  photoMaxBytes: 90000,
};
export const CLOSE_POLICY = {
  requireCashCount: true,
  requireStockCount: true,
  requireUploadsSent: true,
  exceptionsNeedReview: true,
};
/** @param {string} message @param {string} [code] @returns {never} */
export function refuse(message, code = "invalid_transition") {
  throw new ApiError(code, 422, message);
}
/** All externally supplied integers are canonical, nonnegative, safe decimal strings. @param {any} v @param {boolean} [positive] */
export function integer(v, positive = false) {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,15})$/.test(v))
    throw invalid("Use an exact whole-number decimal string");
  const n = BigInt(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || (positive && n === 0n))
    throw invalid("Quantity or amount is outside the supported range");
  return n;
}
/** @param {any} n */
export function safeNumber(n) {
  const value = Number(n);
  if (!Number.isSafeInteger(value))
    throw invalid("Total is outside the supported range");
  return value;
}
/** @param {any} value @returns {string} */
export function uuid(value) {
  if (!isUuid(value)) throw invalid("A valid identifier is required");
  return value;
}
/** @param {any} v @param {number} [max] @param {boolean} [required] */
export function text(v, max = 300, required = false) {
  if (v === null || v === undefined) {
    if (required) throw invalid("Text is required");
    return null;
  }
  if (typeof v !== "string" || v.length > max || /[\x00-\x1f]/.test(v))
    throw invalid("Text is too long or contains control characters");
  if (required && !v.trim()) throw invalid("Text is required");
  return v.trim() || null;
}
/** @param {any} v @param {string[]} options */
export function choice(v, options) {
  if (!options.includes(v))
    throw invalid("Choose a supported reason or method");
  return String(v);
}
/** @param {any} v */
export function date(v) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    throw invalid("Use a valid Manila date");
  return v;
}
/** @param {number} [now] */
export const today = (now = Date.now()) =>
  new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
/** @param {any} v */
export const dayString = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
/** @param {any} v @param {number} [max] */
export function rows(v, max = 100) {
  if (
    !Array.isArray(v) ||
    v.length < 1 ||
    v.length > max ||
    v.some((x) => !x || typeof x !== "object" || Array.isArray(x))
  )
    throw invalid(`Supply 1–${max} lines`);
  return v;
}
/** Correct signed cases/pieces; never label scaled base units as cases. @param {bigint} base @param {bigint} caseBase @param {bigint} scale */
export function units(base, caseBase, scale) {
  const sign = base < 0n ? "−" : "";
  const abs = base < 0n ? -base : base;
  if (caseBase <= 0n || scale <= 0n)
    return {
      cases: null,
      pieces: null,
      display: `${base} base units · unit setup needed`,
    };
  const cases = abs / caseBase,
    remainder = abs % caseBase;
  const pieces = Number(remainder) / Number(scale);
  return {
    cases: Number(cases) * (base < 0n ? -1 : 1),
    pieces: pieces * (base < 0n ? -1 : 1),
    display: `${sign}${cases} cases + ${pieces} pieces`,
  };
}
/** Half-up minor-unit extension; all intermediate arithmetic is exact. @param {bigint} price @param {bigint} quantity @param {bigint} factor */
export function extend(price, quantity, factor) {
  if (factor <= 0n) throw invalid("Unit conversion needs setup");
  return (price * quantity + factor / 2n) / factor;
}
