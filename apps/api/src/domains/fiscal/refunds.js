import { refuse, text } from "../van/model.js";
import { planRefund } from "./refund-math.js";
import { releaseCapForRefund } from "./privilege-cap.js";

/** IP-REFUND: the parts of a refund store tills and vans share. */
export const REFUND_ORG = "sunpride";
const DEFAULT_OVER = 50000n;

/** @param {any} db @param {string} [org] */
export async function refundPolicy(db, org = REFUND_ORG) {
  const [row] =
    await db`select supervisor_over_centavos::text as over from refund_policies where organization_id=${org}`;
  return { supervisorOverCentavos: BigInt(row?.over ?? DEFAULT_OVER) };
}

/** Reasons a phone may offer: customer-return codes that say where the goods go. @param {any} db @param {string} [org] */
export async function refundReasons(db, org = REFUND_ORG) {
  const rows =
    await db`select code,label,requires_note,refund_destination from inventory_reason_codes where organization_id=${org} and active and refund_destination is not null order by label limit 51`;
  if (rows.length > 50)
    refuse("Too many refund reasons; the office must trim the list");
  return rows.map((/** @type {any} */ r) => ({
    code: r.code,
    label: r.label,
    destination: r.refund_destination,
    requiresNote: r.requires_note === true,
  }));
}

/** What a phone that asked with `params.refunds` is told. Old phones never see it. @param {any} db @param {Record<string,any>} [extra] */
export async function refundBundle(db, extra = {}) {
  const policy = await refundPolicy(db);
  return {
    supervisorOverMinor: String(policy.supervisorOverCentavos),
    reasons: await refundReasons(db),
    ...extra,
  };
}

/** @param {any} db @param {any} code @param {any} note @param {string} [org] */
export async function refundReason(db, code, note, org = REFUND_ORG) {
  const c = text(code, 40, true);
  const [row] =
    await db`select code,label,requires_note,refund_destination from inventory_reason_codes where organization_id=${org} and code=${c} and active and refund_destination is not null`;
  if (!row) refuse("Choose why the customer is returning this");
  const n = text(note, 300);
  if (row.requires_note && !n) refuse("Write a short note for this reason");
  return {
    code: row.code,
    label: row.label,
    destination: /** @type {"sellable"|"damaged"} */ (row.refund_destination),
    note: n ?? null,
  };
}

/** What earlier refunds of this sale already took back, per receipt line and per payment method.
 * @param {any} db @param {string} saleId */
export async function priorRefunds(db, saleId) {
  const lines =
    await db`select line_index,sum(quantity_base)::text as qty from sale_refund_lines where sale_id=${saleId} group by line_index`;
  const byLine = new Map(
    lines.map((/** @type {any} */ r) => [Number(r.line_index), BigInt(r.qty)]),
  );
  const tenders =
    await db`select t->>'method' as method,sum((t->>'amountCentavos')::bigint)::text as amount from sale_refunds r cross join lateral jsonb_array_elements(r.tenders) t where r.sale_id=${saleId} group by 1`;
  const byMethod = new Map(
    tenders.map((/** @type {any} */ r) => [r.method, BigInt(r.amount)]),
  );
  return { byLine, byMethod };
}

/**
 * Inward stock lines that put refunded goods back under the SAME lots the sale took (latest allocation first), less what
 * earlier returns and refunds of this sale already put back. Untracked products have no allocations: one line, no lot.
 * @param {any} db @param {{saleSource:"store_sale"|"van_sale", saleId:string, productId:string, locationId:string, quantity:bigint, status:"available"|"damaged", uom:string, unitCostMinor?:number}} o
 */
export async function refundLotLines(db, o) {
  const base = {
    productId: o.productId,
    fromLocationId: null,
    toLocationId: o.locationId,
    uom: o.uom,
    toStockStatus: o.status,
    stockStatus: o.status,
    ...(o.unitCostMinor == null ? {} : { unitCostMinor: o.unitCostMinor }),
  };
  /** @type {any[]} */ const sold =
    await db`select a.lot_id,sum(a.quantity_base)::text as qty,max(a.allocation_sequence) as seq from inventory_allocations a join inventory_movements m on m.id=a.movement_id where m.source_type=${o.saleSource} and m.source_document_id=${o.saleId}::text and a.product_id=${o.productId} and a.from_location_id=${o.locationId} and a.lot_id is not null group by a.lot_id order by seq desc`;
  if (!sold.length) return [{ ...base, quantityBase: Number(o.quantity) }];
  /** @type {any[]} */ const back =
    await db`select a.lot_id,sum(a.quantity_base)::text as qty from inventory_allocations a join inventory_movements m on m.id=a.movement_id where m.movement_type='pos_return' and a.product_id=${o.productId} and a.to_location_id=${o.locationId} and a.lot_id is not null and ((m.source_type in ('store_refund','van_refund') and m.source_document_id in (select id::text from sale_refunds where sale_id=${o.saleId})) or (m.source_type='van_return' and m.source_document_id in (select id::text from van_returns where sale_id=${o.saleId}))) group by a.lot_id`;
  const returned = new Map(back.map((r) => [r.lot_id, BigInt(r.qty)]));
  let left = o.quantity;
  const lines = [];
  for (const row of sold) {
    const open = BigInt(row.qty) - (returned.get(row.lot_id) ?? 0n);
    if (open <= 0n || left <= 0n) continue;
    const take = open < left ? open : left;
    lines.push({ ...base, quantityBase: Number(take), lotId: row.lot_id });
    left -= take;
  }
  if (left > 0n) refuse("That is more than the sold batches still allow");
  return lines;
}

/** Display quantity of a refunded part of a line, same unit as the original. @param {any} line @param {bigint} part @param {bigint} sold */
function displayQuantity(line, part, sold) {
  if (line.quantity === null) return String(part);
  const n = (Number(line.quantity) * Number(part)) / Number(sold);
  return String(Math.round(n * 1e6) / 1e6);
}

/** One refunded line in the SAME shape as the original line, so the print model and the e-journal read it unchanged.
 * @param {any} o plan line @param {"store"|"van"} surface */
export function refundedLine(o, surface) {
  const l = o.line.raw;
  const q = o.quantityBase;
  if (surface === "van") {
    const paid = BigInt(l.paidBase ?? l.quantityBase);
    const part =
      o.line.quantityBase === 0n
        ? 0n
        : (paid * q + o.line.quantityBase / 2n) / o.line.quantityBase;
    const { allocations: _lots, ...rest } = l;
    return {
      ...rest,
      lineNumber: o.lineIndex + 1,
      quantityBase: String(q),
      paidBase: String(part > q ? q : part),
      freeBase: String(q - (part > q ? q : part)),
      totalMinor: String(o.amountCentavos),
      grossMinor: String(o.grossCentavos),
      discountMinor: String(o.promoCentavos),
      refundsLine: o.lineIndex + 1,
    };
  }
  return {
    ...l,
    quantity: displayQuantity(o.line, q, o.line.quantityBase),
    quantityBase: String(q),
    lineTotalCentavos: Number(o.amountCentavos),
    discountCentavos: Number(o.grossCentavos - o.amountCentavos),
    promoDiscountCentavos: Number(o.promoCentavos),
    privilegeDiscountCentavos: Number(o.privilegeDiscountCentavos),
    vatRemovedCentavos: Number(o.vatRemovedCentavos),
    refundsLine: o.lineIndex + 1,
  };
}

/**
 * The credit memo's frozen facts. It mirrors the original's tax facts (`tax` has the same keys as a sales invoice, positive
 * amounts, so the tax summary's credit-memo branch subtracts it) and names the invoice it undoes.
 * @param {{surface:"store"|"van", receipt:any, originalNumber:string, saleId:string, refundId:string, plan:ReturnType<typeof planRefund>, tenders:{method:string,label:string,amountCentavos:bigint}[], reason:{code:string,label:string,destination:string,note:string|null}, cashier:string|null, supervisorName?:string|null, at:number}} o
 */
export function creditMemoSnapshot(o) {
  const r = o.receipt;
  return {
    refundId: o.refundId,
    originalInvoice: o.originalNumber,
    originalSaleId: o.saleId,
    currency: "PHP",
    ...(o.surface === "store"
      ? { store: r.store, register: r.register, terminal: r.terminal }
      : {
          customer: r.customer,
          seller: r.seller,
          truck: r.truck,
          tripNumber: r.tripNumber,
        }),
    cashier: o.cashier,
    soldAt: o.at,
    totalMinor: String(o.plan.total),
    lines: o.plan.lines.map((l) => refundedLine(l, o.surface)),
    tenders: o.tenders.map((t) => ({
      method: t.method,
      label: t.label,
      amountCentavos: String(t.amountCentavos),
    })),
    ...(r.buyer ? { buyer: r.buyer } : {}),
    ...(r.discountClaim ? { discountClaim: r.discountClaim } : {}),
    reason: {
      code: o.reason.code,
      label: o.reason.label,
      destination: o.reason.destination,
    },
    note: o.reason.note,
    ...(o.supervisorName ? { approvedBy: o.supervisorName } : {}),
    tax: o.plan.tax,
  };
}

/** @param {any} db @param {any} row */
export async function insertRefund(db, row) {
  await db`insert into sale_refunds(id,surface,sale_id,original_number,shift_id,trip_id,device_id,requested_by,supervisor_profile_id,credit_number,fiscal_document_id,reason_code,note,destination,total_centavos,tax,lines,tenders,movement_id,captured_request,refunded_at) values(${row.id},${row.surface},${row.saleId},${row.originalNumber},${row.shiftId ?? null},${row.tripId ?? null},${row.deviceId},${row.requestedBy},${row.supervisorProfileId ?? null},${row.creditNumber},${row.documentId},${row.reason.code},${row.reason.note},${row.reason.destination},${String(row.plan.total)},${row.plan.tax},${row.lines},${row.tenders},${row.movementId},${row.captured},${new Date(row.at)})`;
  for (const l of row.plan.lines)
    await db`insert into sale_refund_lines(refund_id,sale_id,line_index,product_id,quantity_base,amount_centavos) values(${row.id},${row.saleId},${l.lineIndex},${l.productId},${String(l.quantityBase)},${String(l.amountCentavos)})`;
  // IP-INT5: a senior / PWD sale gives back its share of the weekly limit.
  if (row.receipt)
    await releaseCapForRefund(db, {
      refundId: row.id,
      saleId: row.saleId,
      receipt: row.receipt,
      plan: row.plan,
    });
}

/** The picks a phone sends, checked to the shape the maths wants. @param {any} lines */
export function readPicks(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100)
    refuse("Choose at least one item to refund");
  return lines.map((/** @type {any} */ l) => {
    if (!l || typeof l !== "object" || !Number.isInteger(l.lineIndex))
      refuse("Each refund line must name its receipt line");
    if (!/^[0-9]{1,15}$/.test(String(l.quantityBase)))
      refuse("Refund quantity must be a whole number of pieces");
    return {
      lineIndex: /** @type {number} */ (l.lineIndex),
      productId: typeof l.productId === "string" ? l.productId : undefined,
      quantityBase: BigInt(l.quantityBase),
    };
  });
}
