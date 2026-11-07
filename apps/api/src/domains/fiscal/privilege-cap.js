/**
 * IP-SCPWD-CAP: the weekly purchase cap on the senior citizen / PWD discount.
 *
 * Legal basis (details and sources in reports/scpwd-cap-report.md): the 5% special discount on basic necessities and prime
 * commodities is limited to purchases of PHP 2,500 a week (PHP 125 of discount) per senior citizen or PWD, no carry-over
 * (JAO 24-02 s.2024, replacing JAO 17-02 s.2017's PHP 1,300). The amount is an office setting; the shipped default is a
 * default that Sunpride's accountant must confirm.
 *
 * What the cap measures: the regular (gross, VAT-included) price of the purchase that actually got the senior/PWD discount.
 * A line that does not get the discount (promotion was better, or the cashier left it out) does not use the limit.
 *
 * The server is the authority:
 *   - `authority` mode (web, online preview): the discount goes only to the part of the purchase that fits in what is left.
 *   - `reconcile` mode (a sale that was already made on a phone): the phone's own number stands, because the customer was
 *     already given that receipt. A phone that knows the limit (new builds) says how much of the purchase it discounted
 *     (`discountClaim.capBasis.budgetCentavos`); an older phone says nothing and is treated as uncapped. Whatever went past
 *     what the server still had left is recorded as an overage and shown in the Decide inbox. The sale is never rejected for it.
 *
 * Week = Monday to Sunday, Manila time. Week usage is the ledger `privilege_cap_ledger`, summed per ID across every store and van.
 * Everything is integer centavos. The allocation below is mirrored in Kotlin (`Privilege.cart`) and both are tested against
 * `test/fixtures/privilege-cap-vectors.json`.
 */
import { computeLine } from "./privilege.js";

/** Shipped default: PHP 2,500 of purchases a week (JAO 24-02 s.2024). To be confirmed with Sunpride's accountant. */
export const DEFAULT_WEEKLY_CAP_CENTAVOS = 250000;
/** Only the 5% basic-necessities discount has a weekly limit, so only these two claim types use it. */
export const CAP_TYPES = Object.freeze(["senior", "pwd"]);
export const DEFAULT_NOTE = "Default — confirm with Sunpride accountant";
const MANILA_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** @param {number|bigint} c */
const peso = (c) =>
  `₱${(Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Weekly limit: ₱1,300.00 left". The same words the phone prints. @param {number|bigint} leftCentavos */
export const weeklyLimitText = (leftCentavos) =>
  `Weekly limit: ${peso(leftCentavos)} left`;

/** Manila date (YYYY-MM-DD) of the Monday that starts the week of this instant. @param {number} ms */
export function manilaWeekStart(ms) {
  const local = ms + MANILA_OFFSET_MS;
  const dow = new Date(local).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - sinceMonday * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** First instant of the next week (Monday 00:00 Manila) as epoch ms. @param {number} ms */
export function manilaWeekEndsAt(ms) {
  const start = Date.parse(`${manilaWeekStart(ms)}T00:00:00Z`) - MANILA_OFFSET_MS;
  return start + 7 * DAY_MS;
}

/** `senior:1234ABCD` — type plus the card number with spaces, dashes, dots and slashes removed, upper case.
 * @param {string} type @param {string} idNumber */
export function idKey(type, idNumber) {
  return `${type}:${String(idNumber).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
}

/** The only form of an ID that leaves the server toward a phone. @param {string} key */
export function idHash(key) {
  return new Bun.CryptoHasher("sha256")
    .update(`sunpride-privcap-v1|${key}`)
    .digest("hex")
    .slice(0, 32);
}

/** The limit in force at `at`. @param {any} db @param {number} at */
export async function capSetting(db, at) {
  const [row] = await db`select enabled,cap_centavos,accountant_confirmed,note,effective_from from privilege_cap_settings
    where organization_id='sunpride' and effective_from<=${new Date(at)} order by effective_from desc,created_at desc limit 1`;
  if (!row)
    return {
      enabled: true,
      capCentavos: DEFAULT_WEEKLY_CAP_CENTAVOS,
      accountantConfirmed: false,
      note: DEFAULT_NOTE,
      isDefault: true,
      effectiveFrom: null,
    };
  return {
    enabled: row.enabled === true,
    capCentavos: Number(row.cap_centavos),
    accountantConfirmed: row.accountant_confirmed === true,
    note: row.note ?? null,
    isDefault: false,
    effectiveFrom: new Date(row.effective_from).getTime(),
  };
}

/** Purchase already discounted this week for one ID, every store and van. A voided invoice gives its part back.
 * @param {any} db @param {string} key @param {string} week */
export async function usedThisWeek(db, key, week) {
  const [row] = await db`select coalesce(sum(l.applied_gross_centavos),0)::text as used from privilege_cap_ledger l
    where l.id_key=${key} and l.week_start=${week}::date
      and not exists (select 1 from fiscal_document_events e where e.document_id=l.fiscal_document_id and e.kind='void')`;
  return Number(row?.used ?? 0);
}

/** Two phones syncing sales for the same card at once must see each other's use. @param {any} db @param {string} key @param {string} week */
export async function lockWeek(db, key, week) {
  await db`select pg_advisory_xact_lock(hashtextextended(${`privcap:${key}:${week}`},0))`;
}

/** Add two line results (a line split by the cap). @param {any} a @param {any} b */
function merge(a, b) {
  /** @type {any} */ const out = { privilegeType: a.privilegeType };
  for (const k of Object.keys(a)) if (k !== "privilegeType") out[k] = a[k] + b[k];
  return out;
}

/** Half-up integer a*b/d for non-negative integers. @param {number} a @param {number} b @param {number} d */
function mulDivRound(a, b, d) {
  const n = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  return Number((2n * n + D) / (2n * D));
}

/**
 * Work out every line, letting at most `budget` centavos of the regular price carry the privilege discount, in line order.
 * A line that does not fit whole is split: the part that fits gets the discount, the rest is a plain line (its promotion
 * share pro rata, half up). `budget` null = no limit (same as no cap).
 *
 * @param {any[]} lines  LegalLine[] (productId, grossCentavos, promoDiscountCentavos, tax fields)
 * @param {(l:any, gross:number, promo:number, withPrivilege:boolean)=>any} compute  one line's result (privilege.js)
 * @param {(l:any)=>boolean} takes  does this line ask for the privilege (claim eligibility)
 * @param {number|null} budget
 * @returns {{results:any[], appliedGross:number, eligibleGross:number}}
 */
export function computeWithBudget(lines, compute, takes, budget) {
  let left = budget === null ? Number.POSITIVE_INFINITY : budget;
  let appliedGross = 0,
    eligibleGross = 0;
  const results = lines.map((l) => {
    const asked = takes(l);
    const full = compute(l, l.grossCentavos, l.promoDiscountCentavos, asked);
    if (!full.privilegeType) return full;
    eligibleGross += l.grossCentavos;
    const take = Math.min(l.grossCentavos, left);
    if (take >= l.grossCentavos) {
      left -= take;
      appliedGross += take;
      return full;
    }
    if (take <= 0)
      return compute(l, l.grossCentavos, l.promoDiscountCentavos, false);
    const promoA = mulDivRound(l.promoDiscountCentavos, take, l.grossCentavos);
    const a = compute(l, take, promoA, true);
    const b = compute(
      l,
      l.grossCentavos - take,
      l.promoDiscountCentavos - promoA,
      false,
    );
    if (a.privilegeType) {
      left -= take;
      appliedGross += take;
    }
    return merge(a, b);
  });
  return { results, appliedGross, eligibleGross };
}

/** One line through privilege.js (qty 1 at its gross, like the phone). @param {any} l @param {number} gross @param {number} promo @param {string|null} type */
export function computeOne(l, gross, promo, type) {
  return computeLine({
    unitPriceCentavos: gross,
    qty: 1,
    vatRateBps: l.taxBasisPoints ?? 0,
    taxTreatment: l.taxTreatment,
    privilege: type ? { type } : null,
    promoDiscountCentavos: promo,
  });
}

/** What a phone's bundle needs: this week's limit and each ID's use so far (hashed, newest week only). @param {any} db @param {number} at */
export async function capBundle(db, at) {
  const setting = await capSetting(db, at);
  const week = manilaWeekStart(at);
  const rows = await db`select l.id_hash,sum(l.applied_gross_centavos)::text as used from privilege_cap_ledger l
    where l.week_start=${week}::date
      and not exists (select 1 from fiscal_document_events e where e.document_id=l.fiscal_document_id and e.kind='void')
    group by l.id_hash order by sum(l.applied_gross_centavos) desc limit 2001`;
  return {
    version: 1,
    enabled: setting.enabled,
    capCentavos: String(setting.capCentavos),
    confirmed: setting.accountantConfirmed,
    weekStart: week,
    weekEndsAt: manilaWeekEndsAt(at),
    asOf: at,
    complete: rows.length <= 2000,
    used: rows.slice(0, 2000).map((/** @type {any} */ r) => ({ k: r.id_hash, v: r.used })),
  };
}
