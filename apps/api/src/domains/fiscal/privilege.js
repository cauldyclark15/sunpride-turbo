/**
 * Philippine privilege-discount and VAT line math (pure, integer centavos, half-up rounding).
 * Formulas follow the Itemcount BIR guide (R1 section 2): prices are VAT-inclusive.
 *
 *   net          = round(gross / (1 + vat))          VAT-exclusive amount of the line
 *   vatRemoved   = gross - net
 *   discount     = round(net * pct)                  pct: 20% senior, PWD, athlete; 10% solo parent, uniformed
 *   senior, PWD, solo parent, uniformed:  VAT is removed, then the discount comes off the VAT-exclusive amount
 *   athlete:                              the 20% comes off the VAT-exclusive amount, VAT stays
 *   exempt / zero-rated lines:            no VAT to remove; the discount is taken on the line amount
 *   promo and privilege never stack: the larger benefit to the customer wins, a tie goes to the promo
 *
 * Bucket convention (BIR): the sales buckets are shown BEFORE the privilege discount, so
 *   vatable + vat + vatExempt + zeroRated = net (amount to pay) + privilegeDiscount.
 * `netCentavos` is what the customer pays for the line, not the VAT-exclusive amount.
 * Same half-up arithmetic as `invoiceTaxSnapshot` in taxes.js for the plain (no privilege) case.
 */
import { invalid } from "../../core/errors.js";

export const PRIVILEGE_TYPES = Object.freeze([
  "senior",
  "pwd",
  "solo_parent",
  "athlete",
  "uniformed",
]);
export const PRIVILEGE_LABELS = Object.freeze({
  senior: "Senior citizen",
  pwd: "PWD",
  solo_parent: "Solo parent",
  athlete: "National athlete/coach",
  uniformed: "Uniformed personnel",
});
/** Discount rate in basis points of the VAT-exclusive amount. */
export const PRIVILEGE_RATE_BPS = Object.freeze({
  senior: 2000,
  pwd: 2000,
  athlete: 2000,
  solo_parent: 1000,
  uniformed: 1000,
});
/** Athletes keep VAT; every other privilege removes it. */
const KEEPS_VAT = new Set(["athlete"]);
const TREATMENTS = ["vatable", "exempt", "zero_rated"];

/** Half-up integer division for non-negative BigInts. @param {bigint} n @param {bigint} d */
const divRound = (n, d) => (2n * n + d) / (2n * d);

/** @param {any} v @param {string} name @returns {bigint} */
function centavos(v, name) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw invalid(
      `${name} must be whole centavos, zero or more.`,
      "invalid_amount",
    );
  return BigInt(v);
}

/** gross = round(unitPrice * qty), half-up; qty may be fractional (weighed goods).
 * @param {bigint} unit @param {number} qty */
function grossOf(unit, qty) {
  if (Number.isInteger(qty)) return unit * BigInt(qty);
  const x = Number(unit) * qty;
  return BigInt(Math.floor(x + 0.5));
}

/**
 * @typedef {{
 *  unitPriceCentavos:number, qty:number, vatRateBps?:number,
 *  taxTreatment:'vatable'|'exempt'|'zero_rated',
 *  privilege?:{type:string}|null, promoDiscountCentavos?:number
 * }} LineInput
 * @typedef {{
 *  grossCentavos:number, vatableCentavos:number, vatCentavos:number, vatExemptCentavos:number,
 *  zeroRatedCentavos:number, privilegeDiscountCentavos:number, promoDiscountCentavos:number,
 *  netCentavos:number, vatRemovedCentavos:number, privilegeType:string|null
 * }} LineResult
 */

/** @param {LineInput} l @returns {LineResult} */
export function computeLine(l) {
  if (!l || typeof l !== "object")
    throw invalid("Line is required.", "invalid_line");
  if (!(typeof l.qty === "number" && Number.isFinite(l.qty) && l.qty > 0))
    throw invalid("Quantity must be more than zero.", "invalid_quantity");
  const treatment = l.taxTreatment;
  if (!TREATMENTS.includes(treatment))
    throw invalid("Each line needs a tax treatment.", "invalid_tax_treatment");
  const bps = l.vatRateBps ?? 0;
  if (treatment === "vatable") {
    if (!(Number.isSafeInteger(bps) && bps > 0 && bps <= 10000))
      throw invalid(
        "A VATable line needs its VAT rate.",
        "invalid_tax_treatment",
      );
  }
  const type = l.privilege?.type ?? null;
  if (type !== null && !PRIVILEGE_TYPES.includes(type))
    throw invalid("Unknown discount type.", "invalid_privilege");
  const unit = centavos(l.unitPriceCentavos, "Price");
  const promoAsked = centavos(l.promoDiscountCentavos ?? 0, "Promo discount");
  const gross = grossOf(unit, l.qty);
  const promoCapped = promoAsked > gross ? gross : promoAsked;
  const rate = BigInt(10000 + (treatment === "vatable" ? bps : 0));
  const taxable = treatment === "vatable";

  // What the privilege would give on the full-price line.
  let privDiscount = 0n,
    vatRemoved = 0n,
    netExVat = gross;
  if (type) {
    if (taxable) {
      netExVat = divRound(gross * 10000n, rate);
      vatRemoved = gross - netExVat;
    }
    privDiscount = divRound(
      netExVat *
        BigInt(
          PRIVILEGE_RATE_BPS[
            /** @type {keyof typeof PRIVILEGE_RATE_BPS} */ (type)
          ],
        ),
      10000n,
    );
  }
  const keepsVat = type !== null && KEEPS_VAT.has(type);
  // Benefit to the customer: athletes keep VAT, so only the discount is a benefit.
  const privBenefit = type ? privDiscount + (keepsVat ? 0n : vatRemoved) : 0n;
  const privilegeWins =
    type !== null && privBenefit > promoCapped && gross - privBenefit > 0n;

  let vatable = 0n,
    vat = 0n,
    exempt = 0n,
    zero = 0n,
    pay,
    privOut = 0n,
    promoOut = 0n,
    removedOut = 0n;
  if (privilegeWins) {
    privOut = privDiscount;
    if (taxable && keepsVat) {
      vatable = netExVat;
      vat = vatRemoved;
      pay = gross - privDiscount;
    } else if (taxable) {
      exempt = netExVat;
      removedOut = vatRemoved;
      pay = netExVat - privDiscount;
    } else {
      if (treatment === "exempt") exempt = gross;
      else zero = gross;
      pay = gross - privDiscount;
    }
  } else {
    promoOut = promoCapped;
    pay = gross - promoCapped;
    if (taxable) {
      vatable = divRound(pay * 10000n, rate);
      vat = pay - vatable;
    } else if (treatment === "exempt") exempt = pay;
    else zero = pay;
  }
  const n = (/** @type {bigint} */ v) => Number(v);
  return {
    grossCentavos: n(gross),
    vatableCentavos: n(vatable),
    vatCentavos: n(vat),
    vatExemptCentavos: n(exempt),
    zeroRatedCentavos: n(zero),
    privilegeDiscountCentavos: n(privOut),
    promoDiscountCentavos: n(promoOut),
    netCentavos: n(pay),
    vatRemovedCentavos: n(removedOut),
    privilegeType: privilegeWins ? type : null,
  };
}

/**
 * Sum the lines. A cart-level privilege applies to every line unless the line has its own
 * `privilege` (a different type) or `privilege: null` (not eligible, e.g. a mixed cart).
 * @param {LineInput[]} lines @param {{privilege?:{type:string}|null}} [opts]
 */
export function computeCart(lines, { privilege } = {}) {
  if (!Array.isArray(lines) || !lines.length)
    throw invalid("Add at least one item.", "invalid_line");
  const out = lines.map((l) =>
    computeLine(l.privilege === undefined ? { ...l, privilege } : l),
  );
  const sum = (/** @type {keyof LineResult} */ k) =>
    out.reduce((a, r) => a + /** @type {number} */ (r[k]), 0);
  return {
    gross: sum("grossCentavos"),
    vatable: sum("vatableCentavos"),
    vat: sum("vatCentavos"),
    vatExempt: sum("vatExemptCentavos"),
    zeroRated: sum("zeroRatedCentavos"),
    vatRemoved: sum("vatRemovedCentavos"),
    privilegeDiscount: sum("privilegeDiscountCentavos"),
    promoDiscount: sum("promoDiscountCentavos"),
    total: sum("netCentavos"),
    lines: out,
  };
}
