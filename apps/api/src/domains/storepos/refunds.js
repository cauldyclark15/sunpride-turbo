import { postMovement } from "../inventory/posting.js";
import { issueDocument } from "../fiscal/series.js";
import { enqueueSapPosting } from "../fiscal/transactions.js";
import { canonicalJson } from "../../core/util.js";
import { integer, uuid, refuse } from "../van/model.js";
import { canonicalOrder } from "./commercial.js";
import { useSupervisor } from "./overrides.js";
import {
  planRefund,
  refundTenders,
  needsSupervisor,
} from "../fiscal/refund-math.js";
import {
  refundPolicy,
  refundReason,
  priorRefunds,
  refundLotLines,
  creditMemoSnapshot,
  refundedLine,
  insertRefund,
  readPicks,
} from "../fiscal/refunds.js";

/**
 * IP-REFUND: refund part of a store sale. Runs inside the cashier's open session (storeOperation already refused a closed
 * session or sales day), so the cash that leaves the drawer lands in THAT session's expected cash.
 * The server recomputes every amount from the frozen original receipt; the phone's `expectedCentavos` must agree.
 * @param {any} c store op context (db, actor, device, register, shift, now, payload)
 */
export async function refundPart(c) {
  const { db, actor, device, register: r, shift, payload: p } = c;
  const id = uuid(p.refundId);
  if (id !== uuid(c.op.clientOpId))
    refuse("Refund identifier must be the operation identifier");
  const [old] = await db`select * from sale_refunds where id=${id}`;
  if (old) {
    if (
      old.surface !== "store" ||
      old.shift_id !== shift.id ||
      canonicalJson(old.captured_request) !== canonicalJson(p)
    )
      refuse("Refund identifier has different content", "idempotency_conflict");
    return { entityId: id, movementId: old.movement_id };
  }
  const [sale] =
    await db`select s.*,h.register_id from store_sales s join store_shifts h on h.id=s.shift_id where s.id=${uuid(p.saleId)} for update of s`;
  if (!sale || sale.register_id !== r.id)
    refuse("Choose a receipt from this store");
  const [order] = await db`select * from orders where id=${sale.order_id}`;
  if (order.status === "voided")
    refuse("This sale was voided, so there is nothing left to refund");
  const [whole] =
    await db`select status,kind from store_reversals where sale_id=${sale.id} and status<>'rejected'`;
  if (whole)
    refuse(
      "This whole sale is already being voided or refunded. Nothing is left to refund by item.",
    );
  const prior = await priorRefunds(db, sale.id);
  const plan = planRefund({
    receipt: sale.receipt,
    prior: prior.byLine,
    picks: readPicks(p.lines),
  });
  if (integer(p.expectedCentavos) !== plan.total)
    refuse(
      "The refund amount changed. Check the items and try again.",
      "stock_conflict",
    );
  const reason = await refundReason(
    db,
    p.reasonCode,
    p.note,
    r.organization_id,
  );
  const policy = await refundPolicy(db, r.organization_id);
  const used = await useSupervisor(c, {
    kind: "refund",
    refType: "refund",
    refId: id,
    amountCentavos: String(plan.total),
    reason: `${reason.label}${reason.note ? `: ${reason.note}` : ""}`,
    required: needsSupervisor(plan.total, policy.supervisorOverCentavos),
  });
  const tenders = refundTenders(
    sale.receipt.tenders ?? [],
    prior.byMethod,
    plan.total,
  );
  // The phone says where it thinks the money goes; the two must agree (a phone that sends none is not checked).
  if (Array.isArray(p.tenders)) {
    const mine = canonicalJson(
      tenders.map((t) => ({ method: t.method, amountCentavos: String(t.amountCentavos) })),
    );
    const theirs = canonicalJson(
      p.tenders.map((/** @type {any} */ t) => ({
        method: t?.method,
        amountCentavos: String(t?.amountCentavos),
      })),
    );
    if (mine !== theirs)
      refuse(
        "The refund amount changed. Check the items and try again.",
        "stock_conflict",
      );
  }
  // Credit memo: number reserved on the phone from its own credit-memo range (same machinery as the invoice).
  const [registration] =
    await db`select r.org_unit_id from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id where a.id=${uuid(p.fiscal?.allocationId)}`;
  if (registration?.org_unit_id !== r.org_unit_id)
    refuse("Credit memo range belongs to another branch");
  const snapshot = creditMemoSnapshot({
    surface: "store",
    receipt: sale.receipt,
    originalNumber: sale.receipt_number,
    saleId: sale.id,
    refundId: id,
    plan,
    tenders,
    reason,
    cashier: actor.name,
    supervisorName: used?.supervisor?.name ?? null,
    at: c.now,
  });
  const document = await issueDocument(db, {
    actor,
    deviceId: device.id,
    vehicleId: null,
    allocationId: p.fiscal.allocationId,
    serial: p.fiscal.serial,
    documentType: "credit_memo",
    sourceType: "store_refund",
    sourceId: id,
    at: c.now,
    snapshot,
  });
  if (document.document_number !== p.creditNumber)
    refuse("Credit memo number differs from its fiscal allocation");
  // Stock goes back through the single writer: sellable or damaged by the reason, under the lots the sale took.
  const status = reason.destination === "damaged" ? "damaged" : "available";
  const stock = [];
  for (const o of plan.lines) {
    const [unit] =
      await db`select l.unit_cost_minor from inventory_movement_lines l where l.movement_id=${sale.movement_id} and l.product_id=${o.productId} limit 1`;
    stock.push(
      ...(await refundLotLines(db, {
        saleSource: "store_sale",
        saleId: sale.id,
        productId: o.productId,
        locationId: r.location_id,
        quantity: o.quantityBase,
        status,
        uom: "base",
        unitCostMinor: Number(unit?.unit_cost_minor ?? 0),
      })),
    );
  }
  const movement = await postMovement(db, {
    kind: "pos_return",
    sourceType: "store_refund",
    sourceId: id,
    idempotencyKey: `store-refund:${id}`,
    occurredAt: c.now,
    organizationId: r.organization_id,
    actor: { profileId: actor.profileId, userId: actor.userId },
    authorizedLocations: [r.location_id],
    lines: stock,
  });
  // Cash (or e-wallet / card) that goes back to the customer: negative tenders on THIS session, like a whole-sale refund.
  for (const t of tenders)
    await db`insert into store_tenders(shift_id,sale_id,operation_id,method,reference,amount_centavos,label,status) values(${shift.id},${sale.id},${c.op.clientOpId},${t.method},${null},${String(-t.amountCentavos)},${t.label},'reversed')`;
  // The credit order keeps analytics and the Z reading's sales net of the refund.
  await canonicalOrder(c, {
    id,
    number: document.document_number,
    customerCode: order.customer_code,
    outletId: order.outlet_id,
    channel: order.channel_key,
    total: -Number(plan.total),
    lines: plan.lines.map((o) => {
      const l = refundedLine(o, "store");
      return {
        ...l,
        quantity: -Number(l.quantity),
        quantityBase: -Number(o.quantityBase),
        lineTotalCentavos: -Number(o.amountCentavos),
      };
    }),
    movementId: movement.movementId,
    originalId: order.id,
    salespersonId: order.salesperson_profile_id,
    salespersonSubject: order.salesperson_subject,
  });
  // Loyalty: take back the points this part of the sale earned (what was redeemed is not given back).
  const earned =
    await db`select customer_id,sum(delta) filter (where kind='earn') as earned from store_points where sale_id=${sale.id} group by customer_id`;
  const saleTotal = BigInt(sale.receipt.totalMinor);
  for (const e of earned) {
    if (!e.earned || saleTotal === 0n) continue;
    const part =
      (BigInt(e.earned) * plan.total * 2n + saleTotal) / (saleTotal * 2n);
    if (part > 0n)
      await db`insert into store_points(customer_id,sale_id,delta,kind) values(${e.customer_id},${sale.id},${String(-part)},'reverse')`;
  }
  await enqueueSapPosting(db, document);
  await insertRefund(db, {
    id,
    surface: "store",
    saleId: sale.id,
    originalNumber: sale.receipt_number,
    shiftId: shift.id,
    deviceId: device.id,
    requestedBy: actor.profileId,
    supervisorProfileId: used?.supervisorProfileId ?? null,
    creditNumber: document.document_number,
    documentId: document.id,
    reason,
    plan,
    lines: plan.lines.map((o) => ({
      lineIndex: o.lineIndex,
      productId: o.productId,
      description: o.line.description,
      quantityBase: String(o.quantityBase),
      amountCentavos: String(o.amountCentavos),
    })),
    tenders: tenders.map((t) => ({
      method: t.method,
      label: t.label,
      amountCentavos: String(t.amountCentavos),
    })),
    movementId: movement.movementId,
    captured: p,
    at: c.now,
  });
  return { entityId: id, movementId: movement.movementId };
}
