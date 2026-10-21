import { ApiError } from "../../core/errors.js";
/** F-112: cached SAP facts are displayable when stale, but never renewed into an offline credit grant.
 * The office offline ceiling is restrictive; it cannot enlarge SAP's account allowance.
 * @param {any} decision @param {any} terms @param {string|null} customerCode @param {number} at */
export function creditView(decision, terms, customerCode, at) {
  const amount = (/** @type {any} */ v) =>
    v === null || v === undefined
      ? null
      : /^\d{1,16}$/.test(String(v))
        ? BigInt(v)
        : null;
  const limit = amount(decision?.limit),
    exposure = amount(
      decision?.exposure ?? decision?.snapshot?.exposureCentavos,
    ),
    ceiling =
      terms?.currency === "PHP" ? amount(terms.credit_limit_minor) : null;
  const checkedAt = decision?.checkedAt ?? decision?.snapshot?.asOf ?? null,
    expiresAt = decision?.expiresAt ?? null;
  const fresh =
    decision &&
    decision.status !== "unknown" &&
    Number.isSafeInteger(checkedAt) &&
    Number.isSafeInteger(expiresAt) &&
    checkedAt <= at + 60000 &&
    expiresAt > at;
  const freshness = fresh
    ? decision.freshness === "live"
      ? "live"
      : "cached"
    : checkedAt === null
      ? "unknown"
      : "stale";
  let available = null;
  if (
    fresh &&
    ceiling !== null &&
    ["within", "no_limit"].includes(decision.status)
  ) {
    if (decision.status === "no_limit" && limit === null) available = ceiling;
    else if (limit !== null && exposure !== null)
      available = limit > exposure ? limit - exposure : 0n;
    if (available !== null && available > ceiling) available = ceiling;
  }
  return {
    version: 1,
    customerCode,
    status: decision?.status ?? "unknown",
    freshness,
    source: decision?.source ?? "sap",
    checkedAt,
    expiresAt,
    limitMinor: limit === null ? null : String(limit),
    exposureMinor: exposure === null ? null : String(exposure),
    availableMinor: available === null ? null : String(available),
    offlineCeilingMinor: ceiling === null ? null : String(ceiling),
    termsDays: terms?.terms_days ?? null,
  };
}
/** @param {any} db @param {string|null} customerCode @param {any} terms @param {number} at */
export async function cachedCreditView(db, customerCode, terms, at) {
  const [r] = customerCode
    ? await db`select * from sap_credit_decisions where customer_code=${customerCode} order by checked_at desc limit 1`
    : [];
  return creditView(
    r
      ? {
          status: r.status,
          limit: r.limit_centavos,
          exposure: r.exposure_centavos,
          source: r.source,
          checkedAt: new Date(r.checked_at).getTime(),
          expiresAt: new Date(r.expires_at).getTime(),
        }
      : null,
    terms,
    customerCode,
    at,
  );
}
/** @param {any} db @param {string|null} outletId @param {number} at */
export async function creditTerms(db, outletId, at) {
  if (!outletId) return null;
  const rows =
    await db`select * from outlet_credit_terms where outlet_id=${outletId} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) and deleted_at is null limit 2`;
  if (rows.length > 1)
    throw new ApiError(
      "credit_terms_conflict",
      409,
      "Credit terms overlap; ask the office to correct them",
    );
  return rows[0] ?? null;
}
