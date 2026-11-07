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
import { createHmac } from "node:crypto";
import { computeLine } from "./privilege.js";
import { saleLines, taxLinesFor } from "./refund-math.js";

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

/**
 * IP-INT5FIX: the card number never leaves the server in a form anyone can compute without a secret. Phones get, with the
 * bundle, a key for THIS week only (an HMAC of the week under the server's existing `SYNC_CURSOR_SECRET`; nothing new is stored
 * or kept in the repo) and look a card up by `keyedIdHash(weekKey, idKey)`. A hash from another week, another server, or the
 * old unsalted scheme matches nothing, and no table of card numbers can be built ahead of time.
 * Honest limit: a phone that holds a bundle can still test guesses for the cards used THIS week (it needs the key to look
 * cards up offline). That is why the bundle is only sent to an enrolled, signed-in device that asks for it.
 * @param {Record<string,string|undefined>|undefined} env @param {string} week  Manila Monday, YYYY-MM-DD
 * @returns {string|null} base64url 32-byte key, null when the server has no secret configured
 */
export function capHashKey(env, week) {
  const secret = env?.SYNC_CURSOR_SECRET;
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret)
    .update(`sunpride/privcap-hash/v2|${week}`)
    .digest("base64url");
}

/** What the phone and the bundle both compute: first 128 bits of HMAC-SHA256(weekKey, idKey), hex. @param {string} weekKey @param {string} key */
export function keyedIdHash(weekKey, key) {
  return createHmac("sha256", Buffer.from(weekKey, "base64url"))
    .update(key)
    .digest("hex")
    .slice(0, 32);
}

/** Server-side only (the ledger's own column; it never goes to a phone). @param {string} key */
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

/** Purchase already discounted this week for one ID, every store and van. A voided invoice gives all of it back, a partial refund its share (privilege_cap_releases).
 * @param {any} db @param {string} key @param {string} week */
export async function usedThisWeek(db, key, week) {
  const [row] = await db`select coalesce(sum(l.applied_gross_centavos - (select coalesce(sum(x.released_gross_centavos),0) from privilege_cap_releases x where x.ledger_id=l.id)),0)::text as used from privilege_cap_ledger l
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

/** What a phone's bundle needs: this week's limit, this week's key and each card's use so far (keyed hash, newest week only).
 * Without a configured server secret no card use is sent (`hashKey` null, `complete` false): the phone then sells with no
 * look-up and the server still records and flags any overage. @param {any} db @param {number} at @param {Record<string,string|undefined>} [env] */
export async function capBundle(db, at, env) {
  const setting = await capSetting(db, at);
  const week = manilaWeekStart(at);
  const hashKey = capHashKey(env, week);
  const rows = hashKey
    ? await db`select l.id_key,sum(l.applied_gross_centavos - (select coalesce(sum(x.released_gross_centavos),0) from privilege_cap_releases x where x.ledger_id=l.id))::text as used from privilege_cap_ledger l
    where l.week_start=${week}::date
      and not exists (select 1 from fiscal_document_events e where e.document_id=l.fiscal_document_id and e.kind='void')
    group by l.id_key order by sum(l.applied_gross_centavos - (select coalesce(sum(x.released_gross_centavos),0) from privilege_cap_releases x where x.ledger_id=l.id)) desc limit 2001`
    : [];
  return {
    version: 1,
    enabled: setting.enabled,
    capCentavos: String(setting.capCentavos),
    confirmed: setting.accountantConfirmed,
    weekStart: week,
    weekEndsAt: manilaWeekEndsAt(at),
    asOf: at,
    complete: Boolean(hashKey) && rows.length <= 2000,
    hashKey,
    used: rows
      .slice(0, 2000)
      .map((/** @type {any} */ r) => ({
        k: keyedIdHash(/** @type {string} */ (hashKey), r.id_key),
        v: r.used,
      })),
  };
}

/**
 * IP-INT5: how much of the weekly limit a refund of part of a senior / PWD discounted sale gives back.
 * Share = (regular price of the discounted lines taken back so far) / (regular price of all discounted lines), applied to what
 * the sale used (`applied_gross`). Rounded cumulatively half up, so the refunds of a sale give back exactly what it used and
 * never more. Lines that carried no privilege discount give nothing back. A sale with no ledger row (no claim, an old sale, or
 * the limit was off) gives nothing. Reads only; `releaseCapForRefund` writes.
 * @param {any} db @param {{saleId:string, receipt:any, plan:any}} o
 * @returns {Promise<null | {ledger:any, refundedGross:bigint, released:bigint}>}
 */
export async function capReleaseFor(db, o) {
  const [ledger] =
    await db`select id,id_hash,week_start::text as week_start,applied_gross_centavos::text as applied from privilege_cap_ledger where source_id=${o.saleId}`;
  if (!ledger) return null;
  const applied = BigInt(ledger.applied);
  const lines = saleLines(o.receipt);
  const tax = taxLinesFor(lines, o.receipt?.tax);
  const gives = (/** @type {number} */ i) => {
    const t = tax[i];
    return (
      !!t &&
      (BigInt(t.privilegeDiscountMinor ?? 0) > 0n ||
        BigInt(t.vatRemovedMinor ?? 0) > 0n)
    );
  };
  // No per-line tax facts at all (should not happen on a sale that has a ledger row): share by every line's price.
  const perLine = tax.some((t) => t);
  let wholeGross = 0n;
  lines.forEach((l, i) => {
    if (!perLine || gives(i)) wholeGross += l.gross;
  });
  let nowGross = 0n;
  for (const l of o.plan.lines)
    if (!perLine || gives(l.lineIndex)) nowGross += l.grossCentavos;
  if (wholeGross <= 0n || nowGross <= 0n) return null;
  const [done] =
    await db`select coalesce(sum(refunded_gross_centavos),0)::text as refunded,coalesce(sum(released_gross_centavos),0)::text as released from privilege_cap_releases where ledger_id=${ledger.id}`;
  const before = BigInt(done.refunded);
  let after = before + nowGross;
  if (after > wholeGross) after = wholeGross;
  const target = (2n * applied * after + wholeGross) / (2n * wholeGross);
  const already = BigInt(done.released);
  let release = target - already;
  if (release < 0n) release = 0n;
  if (already + release > applied) release = applied - already;
  return { ledger, refundedGross: after - before, released: release };
}

/** Writes what `capReleaseFor` found: one append-only row per refund. @param {any} db @param {{refundId:string, saleId:string, receipt:any, plan:any}} o @returns {Promise<number>} centavos of limit given back */
export async function releaseCapForRefund(db, o) {
  const r = await capReleaseFor(db, o);
  if (!r) return 0;
  await db`insert into privilege_cap_releases(refund_id,ledger_id,id_hash,week_start,refunded_gross_centavos,released_gross_centavos)
    values(${o.refundId},${r.ledger.id},${r.ledger.id_hash},${r.ledger.week_start}::date,${String(r.refundedGross)},${String(r.released)})`;
  return Number(r.released);
}
