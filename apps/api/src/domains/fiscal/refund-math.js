/**
 * IP-REFUND: the one refund calculation. Pure (no database), integer centavos, half-up rounding.
 *
 * A refund takes back some quantity of some lines of ONE original receipt. Every amount (what the customer gets back, VAT,
 * VAT-exempt, SC/PWD discount, VAT removed, promo) is the original line's frozen amount times the refunded share of that line.
 * Shares are rounded CUMULATIVELY (round(X * (before + now) / sold) - round(X * before / sold)), so refunding a line in three
 * parts adds up to exactly the line's original amount, and the refunds of a sale can never exceed the sale.
 *
 * The phone runs the same maths (pos/Refunds.kt) so the slip it prints agrees with the credit memo the server freezes.
 */
import { refuse } from "../van/model.js";

/** @typedef {{index:number, productId:string, description:string, code:string|null, uom:string|null, quantityBase:bigint, quantity:string|null, payable:bigint, gross:bigint, promo:bigint, unitPrice:string|null, raw:any}} SaleLine */

/** Half-up integer division for non-negative BigInts. @param {bigint} n @param {bigint} d */
const divRound = (n, d) => (2n * n + d) / (2n * d);
/** @param {any} v */
const big = (v) => BigInt(v === undefined || v === null || v === "" ? 0 : v);

/** The refunded part of `amount` when `before` of `sold` units were already refunded and `now` more are. @param {bigint} amount @param {bigint} before @param {bigint} now @param {bigint} sold */
export function share(amount, before, now, sold) {
  if (sold <= 0n || amount === 0n) return 0n;
  return (
    divRound(amount * (before + now), sold) - divRound(amount * before, sold)
  );
}

/** Store and van receipts hold lines in two shapes; this is the one shape the refund maths reads.
 * @param {any} receipt @returns {SaleLine[]} */
export function saleLines(receipt) {
  const lines = receipt?.lines;
  if (!Array.isArray(lines) || !lines.length)
    refuse("This receipt has no lines to refund");
  return lines.map((/** @type {any} */ l, /** @type {number} */ index) => {
    const van = l.totalMinor !== undefined && l.lineTotalCentavos === undefined;
    const payable = big(van ? l.totalMinor : l.lineTotalCentavos);
    return {
      index,
      productId: String(l.productId),
      description: String(
        (van ? (l.name ?? l.code) : (l.description ?? l.productCode)) ?? "Item",
      ),
      code: (van ? l.code : l.productCode) ?? null,
      uom: (van ? l.uomCode : l.uom) ?? null,
      quantityBase: big(l.quantityBase),
      quantity: l.quantity === undefined ? null : String(l.quantity),
      payable,
      gross: van ? big(l.grossMinor) : payable + big(l.discountCentavos),
      promo: van
        ? big(l.discountMinor)
        : big(l.promoDiscountCentavos ?? l.discountCentavos),
      unitPrice: String(
        (van ? l.unitPriceMinor : l.unitPriceCentavos) ?? "0",
      ),
      raw: l,
    };
  });
}

/** Which tax-snapshot line belongs to each receipt line. The snapshot skips zero-gross lines on store sales and on van sales
 * with a discount claim, and holds every line otherwise. @param {SaleLine[]} lines @param {any} tax @returns {(any|null)[]} */
export function taxLinesFor(lines, tax) {
  const t = Array.isArray(tax?.lines) ? tax.lines : [];
  if (t.length === lines.length) return lines.map((_, i) => t[i]);
  const nonZero = lines.filter((l) => l.gross !== 0n);
  if (t.length === nonZero.length) {
    let k = 0;
    return lines.map((l) => (l.gross === 0n ? null : t[k++]));
  }
  return lines.map(() => null);
}

/**
 * @param {{receipt:any, prior?:Map<number,bigint>|Record<number,bigint>, picks:{lineIndex:number, quantityBase:bigint|string|number, productId?:string}[]}} input
 * `prior` = base quantity already refunded per receipt line index.
 */
export function planRefund({ receipt, prior = new Map(), picks }) {
  const lines = saleLines(receipt);
  const before = (/** @type {number} */ i) =>
    prior instanceof Map ? (prior.get(i) ?? 0n) : big(prior[i]);
  if (!Array.isArray(picks) || !picks.length || picks.length > 100)
    refuse("Choose at least one item to refund");
  const taxLines = taxLinesFor(lines, receipt.tax);
  const saleTotal = lines.reduce((n, l) => n + l.payable, 0n);
  const saleTax = receipt.tax ?? {};
  let total = 0n,
    vatable = 0n,
    vat = 0n,
    exempt = 0n,
    zero = 0n,
    gross = 0n,
    promo = 0n,
    privilege = 0n,
    removed = 0n;
  const seen = new Set();
  const out = [];
  for (const pick of picks) {
    const line = lines[pick.lineIndex];
    if (!line || !Number.isInteger(pick.lineIndex))
      refuse("That item is not on the original receipt");
    if (seen.has(pick.lineIndex))
      refuse("Each item appears once in a refund");
    seen.add(pick.lineIndex);
    if (pick.productId !== undefined && pick.productId !== line.productId)
      refuse("That item is not on the original receipt");
    const q = big(pick.quantityBase);
    if (q <= 0n) refuse("Refund at least one piece of each chosen item");
    const done = before(pick.lineIndex);
    if (done + q > line.quantityBase)
      refuse(
        done > 0n
          ? "That is more than was sold and not yet refunded"
          : "That is more than was sold",
        "invalid_request",
      );
    const amount = share(line.payable, done, q, line.quantityBase);
    const tl = taxLines[pick.lineIndex];
    let lineVat = 0n,
      lineBucket = /** @type {"vatable"|"exempt"|"zero"} */ ("vatable"),
      lineRemoved = 0n,
      linePriv = 0n;
    if (tl) {
      lineVat = share(big(tl.vatMinor), done, q, line.quantityBase);
      lineRemoved = share(
        big(tl.vatRemovedMinor),
        done,
        q,
        line.quantityBase,
      );
      linePriv = share(
        big(tl.privilegeDiscountMinor),
        done,
        q,
        line.quantityBase,
      );
      const removesVat = tl.privilegeType && big(tl.vatRemovedMinor) > 0n;
      lineBucket =
        tl.treatment === "zero_rated"
          ? "zero"
          : tl.treatment === "exempt" || removesVat
            ? "exempt"
            : "vatable";
    } else if (saleTotal > 0n) {
      // No per-line facts frozen (very old receipt): use the sale's own mix.
      lineVat = divRound(amount * big(saleTax.vatMinor), saleTotal);
      lineBucket =
        big(saleTax.vatableSalesMinor) > 0n
          ? "vatable"
          : big(saleTax.zeroRatedMinor) > 0n
            ? "zero"
            : "exempt";
    }
    // BIR convention (same as the invoice): the buckets are shown BEFORE the privilege discount,
    // so vatable + vat + exempt + zero-rated = refund total + privilege discount.
    // The bucket total is the original line's own (net of VAT + VAT) prorated, so one piece of a two-piece line shows
    // exactly half of what the invoice showed; without line facts it is the refund plus its privilege discount.
    const bucketAmount =
      tl && tl.netMinor !== undefined
        ? share(
            big(tl.netMinor) + big(tl.vatMinor),
            done,
            q,
            line.quantityBase,
          )
        : amount + linePriv;
    if (lineBucket !== "vatable") lineVat = 0n;
    if (lineVat > bucketAmount) lineVat = bucketAmount;
    const lineGross = share(line.gross, done, q, line.quantityBase);
    const linePromo = share(line.promo, done, q, line.quantityBase);
    if (lineBucket === "vatable") {
      vatable += bucketAmount - lineVat;
      vat += lineVat;
    } else if (lineBucket === "exempt") exempt += bucketAmount;
    else zero += bucketAmount;
    total += amount;
    gross += lineGross;
    promo += linePromo;
    privilege += linePriv;
    removed += lineRemoved;
    out.push({
      lineIndex: pick.lineIndex,
      productId: line.productId,
      quantityBase: q,
      amountCentavos: amount,
      vatCentavos: lineVat,
      bucket: lineBucket,
      grossCentavos: lineGross,
      promoCentavos: linePromo,
      privilegeDiscountCentavos: linePriv,
      vatRemovedCentavos: lineRemoved,
      remainingBase: line.quantityBase - done - q,
      line,
      taxLine: tl,
    });
  }
  return {
    total,
    lines: out,
    tax: {
      inclusive: true,
      rateBasisPoints: saleTax.rateBasisPoints ?? null,
      vatableSalesMinor: String(vatable),
      vatMinor: String(vat),
      vatExemptMinor: String(exempt),
      zeroRatedMinor: String(zero),
      totalMinor: String(total),
      grossMinor: String(gross),
      promoDiscountMinor: String(promo),
      privilegeDiscountMinor: String(privilege),
      vatRemovedMinor: String(removed),
      privilegeType:
        privilege > 0n || removed > 0n ? (saleTax.privilegeType ?? null) : null,
      lines: out.map((o, i) => ({
        lineNumber: i + 1,
        treatment:
          o.taxLine?.treatment ??
          (o.bucket === "zero"
            ? "zero_rated"
            : o.bucket === "exempt"
              ? "exempt"
              : "vatable"),
        taxCode: o.taxLine?.taxCode ?? null,
        rateBasisPoints: o.taxLine?.rateBasisPoints ?? null,
        netMinor: String(
          o.amountCentavos + o.privilegeDiscountCentavos - o.vatCentavos,
        ),
        vatMinor: String(o.vatCentavos),
        totalMinor: String(o.amountCentavos),
        privilegeDiscountMinor: String(o.privilegeDiscountCentavos),
        vatRemovedMinor: String(o.vatRemovedCentavos),
        refundsLine: o.lineIndex + 1,
      })),
    },
  };
}

/**
 * Where the money goes back: cash first (the till gives it from the drawer), then the other methods in the order the sale
 * took them, never more than that method took minus what earlier refunds already returned through it.
 * @param {{method:string, amountCentavos:string|number|bigint, label?:string}[]} tenders the original sale's tenders
 * @param {Record<string,bigint>|Map<string,bigint>} refunded per method, already refunded
 * @param {bigint} total
 * @returns {{method:string,label:string,amountCentavos:bigint}[]}
 */
export function refundTenders(tenders, refunded, total) {
  const done = (/** @type {string} */ m) =>
    refunded instanceof Map ? (refunded.get(m) ?? 0n) : big(refunded[m]);
  const ordered = [
    ...tenders.filter((t) => t.method === "cash"),
    ...tenders.filter((t) => t.method !== "cash"),
  ];
  let left = total;
  /** @type {{method:string,label:string,amountCentavos:bigint}[]} */ const out =
    [];
  for (const t of ordered) {
    if (left <= 0n) break;
    const room = big(t.amountCentavos) - done(t.method);
    if (room <= 0n) continue;
    const give = room < left ? room : left;
    out.push({
      method: t.method,
      label: t.label ?? t.method,
      amountCentavos: give,
    });
    left -= give;
  }
  if (left > 0n)
    refuse("The customer paid less than this refund by those methods");
  return out;
}

/** A refund above the policy amount needs a supervisor. @param {bigint} total @param {bigint|string|number} overCentavos */
export const needsSupervisor = (total, overCentavos) =>
  total > big(overCentavos);
