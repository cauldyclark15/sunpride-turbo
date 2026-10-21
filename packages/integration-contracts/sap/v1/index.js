import material from "./material.schema.json" with { type: "json" };
import condition from "./condition.schema.json" with { type: "json" };
import customer from "./customer.schema.json" with { type: "json" };
import outlet from "./outlet.schema.json" with { type: "json" };
import ar from "./ar.schema.json" with { type: "json" };
import location from "./location.schema.json" with { type: "json" };
import stock from "./stock.schema.json" with { type: "json" };
import order from "./order.schema.json" with { type: "json" };
import invoice from "./invoice.schema.json" with { type: "json" };
import payment from "./payment.schema.json" with { type: "json" };
import goods_movement from "./goods_movement.schema.json" with { type: "json" };
import credit_memo from "./credit_memo.schema.json" with { type: "json" };
import settlement from "./settlement.schema.json" with { type: "json" };
import postingResult from "./posting-result.schema.json" with { type: "json" };
import creditRequest from "./credit-request.schema.json" with { type: "json" };
import creditResult from "./credit-result.schema.json" with { type: "json" };
import creditExceptionRequest from "./credit-exception-request.schema.json" with { type: "json" };
import creditExceptionResult from "./credit-exception-result.schema.json" with { type: "json" };
import masterPage from "./master-page.schema.json" with { type: "json" };
import error from "./error.schema.json" with { type: "json" };

export const masterKinds = [
  "material",
  "condition",
  "customer",
  "outlet",
  "ar",
  "location",
  "stock",
];
import business_partner from "./business_partner.schema.json" with { type: "json" };
import accrual from "./accrual.schema.json" with { type: "json" };
import reversal from "./reversal.schema.json" with { type: "json" };
import release from "./release.schema.json" with { type: "json" };

export const postingKinds = [
  "business_partner",
  "accrual",
  "reversal",
  "release",
  "order",
  "invoice",
  "payment",
  "goods_movement",
  "credit_memo",
  "settlement",
];
/** @type {Record<string, any>} */
export const schemas = {
  business_partner,
  accrual,
  reversal,
  release,
  material,
  condition,
  customer,
  outlet,
  ar,
  location,
  stock,
  order,
  invoice,
  payment,
  goods_movement,
  credit_memo,
  settlement,
  postingResult,
  creditRequest,
  creditResult,
  creditExceptionRequest,
  creditExceptionResult,
  masterPage,
  error,
};

/** F-001: closed, dependency-free validator for the explicitly used JSON Schema subset.
 * Not a general JSON Schema implementation. The conformance test pins supported keywords.
 * @param {any} s @param {any} v @returns {boolean}
 */
function matches(s, v) {
  if (s.anyOf) return s.anyOf.some((/** @type {any} */ x) => matches(x, v));
  if (s.const !== undefined && s.const !== v) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type === "null") return v === null;
  if (
    s.type === "integer" &&
    (!Number.isSafeInteger(v) ||
      v < (s.minimum ?? -Infinity) ||
      v > (s.maximum ?? Infinity))
  )
    return false;
  if (s.type === "boolean" && typeof v !== "boolean") return false;
  if (
    s.type === "string" &&
    (typeof v !== "string" ||
      v.length < (s.minLength ?? 0) ||
      v.length > (s.maxLength ?? Infinity))
  )
    return false;
  if (s.type === "array")
    return (
      Array.isArray(v) &&
      v.length <= (s.maxItems ?? Infinity) &&
      v.every((x) => matches(s.items, x))
    );
  if (s.type === "object") {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    if (
      (s.required ?? []).some((/** @type {string} */ k) => !Object.hasOwn(v, k))
    )
      return false;
    return Object.keys(v).every((k) =>
      s.properties?.[k]
        ? matches(s.properties[k], v[k])
        : s.additionalProperties !== false,
    );
  }
  return true;
}
/** @param {string} name @param {any} value @returns {any} */
export function validate(name, value) {
  if (!schemas[name] || !matches(schemas[name], value))
    throw new Error(`invalid_contract:${name}`);
  return value;
}
/** F-003 canonical effect identity; no locale or insertion-order dependence. @param {any} v @returns {string} */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
/** @param {any} v */
export const payloadHash = (v) =>
  new Bun.CryptoHasher("sha256").update(canonical(v)).digest("hex");
