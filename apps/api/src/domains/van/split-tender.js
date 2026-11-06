import { configuredTender } from "../fiscal/tenders.js";
import { integer, refuse, text } from "./model.js";

/**
 * IP-INT3: a van sale paid with cash plus ONE other tender.
 *
 * Two wire shapes are accepted and both are turned into the same two parts:
 *  - the shape the phone (IP-HH2) sends: `payment: {split:true, method:"split", kind:"split", amountMinor,
 *    parts:[{method, kind, status, amountMinor, tenderedMinor?, changeMinor?, reference?}]}`
 *  - the office shape: `payments: [{tender, amountCentavos, ref?, tenderedCentavos?}]`
 * A one-element `payments` array is a plain single-tender sale. The old `payment` object keeps working untouched.
 *
 * Rules: exactly two parts, exactly one of them cash; the other tender is enabled for the branch at capture time and
 * is not credit (a credit sale keeps its own collection and aging trail, which read `receipt.payment.kind`); both
 * amounts are positive and add up to the sale total; only cash can be handed over in excess, and the change is
 * exactly what cash handed over exceeds the cash part. Only the cash part counts toward expected cash.
 */

/** Amounts arrive as exact decimal strings from the phone; the office shape may send whole numbers.
 * @param {any} v */
const str = (v) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;

/** @param {any} p */
export function wantsSplit(p) {
  return (
    (Array.isArray(p.payments) && p.payments.length > 1) ||
    p.payment?.split === true ||
    Array.isArray(p.payment?.parts)
  );
}

/**
 * A one-element `payments` array becomes the old single `payment` object.
 * @param {any} p
 * @returns {any}
 */
export function singlePaymentOf(p) {
  if (!Array.isArray(p.payments) || p.payments.length !== 1) return p.payment;
  const [x] = p.payments;
  const amount = integer(str(x.amountCentavos ?? x.amountMinor));
  const kind = x.kind ?? (x.tender === "cash" ? "cash" : "other");
  return {
    method: x.tender ?? x.method,
    kind,
    amountMinor: String(amount),
    ...(kind === "cash"
      ? {
          tenderedMinor: String(
            integer(str(x.tenderedCentavos ?? x.tenderedMinor) ?? String(amount)),
          ),
          changeMinor: String(
            integer(str(x.tenderedCentavos ?? x.tenderedMinor) ?? String(amount)) -
              amount,
          ),
          status: "paid",
        }
      : { status: "awaiting_confirmation" }),
    ...(x.ref ?? x.reference ? { reference: x.ref ?? x.reference } : {}),
  };
}

/** @param {any} x */
function rawPart(x) {
  return {
    method: String(x.tender ?? x.method ?? ""),
    amountMinor: integer(str(x.amountCentavos ?? x.amountMinor)),
    tenderedMinor: str(x.tenderedCentavos ?? x.tenderedMinor) ?? null,
    changeMinor: str(x.changeCentavos ?? x.changeMinor) ?? null,
    reference: x.ref ?? x.reference ?? null,
    dueDate: x.dueDate ?? null,
  };
}

/**
 * @param {any} db @param {any} trip @param {any} p @param {bigint} total @param {number} at
 * @returns {Promise<null | {pay:any, method:any, parts:any[]}>}
 */
export async function splitSalePayment(db, trip, p, total, at) {
  if (!wantsSplit(p)) return null;
  const input = Array.isArray(p.payments) ? p.payments : p.payment.parts;
  if (!Array.isArray(input) || input.length !== 2)
    refuse(
      "A split sale takes cash plus one other payment",
      "invalid_request",
    );
  if (
    !Array.isArray(p.payments) &&
    p.payment.amountMinor !== undefined &&
    integer(p.payment.amountMinor) !== total
  )
    refuse("Payment must match the sale total", "invalid_request");
  const raw = input.map(rawPart);
  /** @type {any[]} */
  const parts = [];
  for (const r of raw) {
    if (r.amountMinor <= 0n)
      refuse("Each part of a split payment must be more than zero", "invalid_request");
    const asked = {
      method: r.method,
      reference: r.reference,
      // validateTender wants this status on a reference-required tender; cash and the rest never carry it
      status: "awaiting_confirmation",
    };
    const method = await configuredTender(db, trip.org_unit_id, asked, at);
    if (method.kind === "credit")
      refuse(
        "Credit cannot be part of a split sale; charge the whole sale to the customer's account or pay it another way",
        "invalid_request",
      );
    parts.push({ method, r });
  }
  const cash = parts.filter((x) => x.method.kind === "cash");
  if (cash.length !== 1)
    refuse(
      "A split sale needs exactly one cash part and one other payment",
      "invalid_request",
    );
  const other = parts.find((x) => x.method.kind !== "cash");
  if (!other || other.method.code === cash[0].method.code)
    refuse("Choose a second payment that is not cash", "invalid_request");
  if (cash[0].r.amountMinor + other.r.amountMinor !== total)
    refuse(
      "The two payments must add up to the sale total",
      "invalid_request",
    );
  if (other.r.tenderedMinor !== null && other.r.tenderedMinor !== undefined)
    if (integer(other.r.tenderedMinor) !== other.r.amountMinor)
      refuse("Only cash can give change", "invalid_request");
  const tendered =
    cash[0].r.tenderedMinor === null || cash[0].r.tenderedMinor === undefined
      ? cash[0].r.amountMinor
      : integer(cash[0].r.tenderedMinor);
  if (tendered < cash[0].r.amountMinor)
    refuse("Cash handed over is less than the cash part", "invalid_request");
  const change = tendered - cash[0].r.amountMinor;
  if (
    cash[0].r.changeMinor !== null &&
    cash[0].r.changeMinor !== undefined &&
    BigInt(integer(cash[0].r.changeMinor)) !== BigInt(change)
  )
    refuse("Cash and change do not reconcile", "invalid_request");
  const ordered = [cash[0], other];
  const out = ordered.map(({ method, r }) =>
    method.kind === "cash"
      ? {
          method: method.code,
          kind: "cash",
          label: method.label,
          status: "paid",
          amountMinor: String(r.amountMinor),
          tenderedMinor: String(tendered),
          changeMinor: String(change),
        }
      : {
          method: method.code,
          kind: method.kind,
          label: method.label,
          status: "awaiting_confirmation",
          amountMinor: String(r.amountMinor),
          ...(method.referenceRequired
            ? { reference: text(r.reference, 100, true) }
            : r.reference
              ? { reference: text(r.reference, 100) }
              : {}),
        },
  );
  const label = `${out[0].label} + ${out[1].label}`;
  const pay = {
    split: true,
    method: "split",
    kind: "split",
    label,
    status: "awaiting_confirmation",
    amountMinor: String(total),
    tenderedMinor: String(tendered + other.r.amountMinor),
    changeMinor: String(change),
    parts: out,
  };
  return { pay, method: { kind: "split", label }, parts: out };
}

/**
 * The rows a sale (or the money back for a void) leaves in van_payments: one per part of a split, one otherwise.
 * @param {any} pay
 * @returns {any[]}
 */
export function paymentParts(pay) {
  return pay?.split === true && Array.isArray(pay.parts) ? pay.parts : [pay];
}

/** Print-model tenders of a split sale, in the shape fiscal/print-model.js reads from `snapshot.tenders`.
 * @param {any[]} parts */
export function tendersOfParts(parts) {
  return parts.map((x) => ({
    method: x.kind,
    label: x.label,
    amountCentavos: x.amountMinor,
    tenderedCentavos: x.tenderedMinor ?? null,
    changeCentavos: x.changeMinor ?? "0",
    reference: x.reference ?? null,
  }));
}
