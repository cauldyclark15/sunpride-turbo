import { postMovement } from "../inventory/posting.js";
import { issueDocument } from "../fiscal/series.js";
import { enqueueSapPosting } from "../fiscal/transactions.js";
import { canonicalJson } from "../../core/util.js";
import { integer, uuid, refuse } from "./model.js";
import { audit, explainStock, assertNotCounted, payment } from "./facts.js";
import { paymentParts } from "./split-tender.js";
import { consumeApproval } from "./approvals.js";
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
  insertRefund,
  readPicks,
} from "../fiscal/refunds.js";

/** What the approval code binds: the receipt, the refund amount, the reason and which refund of that receipt this is.
 * @param {any} s original sale row @param {bigint} total @param {string} reasonCode @param {number} refundNumber */
export const refundApprovalFacts = (s, total, reasonCode, refundNumber) => ({
  receiptNumber: s.receipt_number,
  totalMinor: String(total),
  reasonCode,
  refundNumber,
});

/** Refunds already made on this trip, for the phone's "already refunded" figures. @param {any} db @param {string} tripId */
export async function tripRefunds(db, tripId) {
  const rows =
    await db`select r.id,r.sale_id,r.credit_number,r.total_centavos::text as total,r.tenders,r.refunded_at,r.reason_code,(select coalesce(jsonb_agg(jsonb_build_object('lineIndex',l.line_index,'quantityBase',l.quantity_base::text,'amountCentavos',l.amount_centavos::text) order by l.line_index),'[]'::jsonb) from sale_refund_lines l where l.refund_id=r.id) as lines from sale_refunds r where r.trip_id=${tripId} order by r.refunded_at limit 501`;
  if (rows.length > 500) refuse("Too many refunds on one trip; reconcile it");
  return rows.map((/** @type {any} */ x) => ({
    id: x.id,
    saleId: x.sale_id,
    creditNumber: x.credit_number,
    totalMinor: x.total,
    reasonCode: x.reason_code,
    tenders: x.tenders,
    lines: x.lines,
    at: +new Date(x.refunded_at),
  }));
}

/**
 * IP-REFUND: refund part of a van sale. Offline op `refund.record`, idempotent on `refundId`.
 * Stock goes back on the truck (sellable or damaged by the reason), the cash leaves as a `refund` payment so the trip's
 * expected cash drops, and the credit memo takes its number from the phone's own credit-memo range.
 * @param {any} db @param {any} trip @param {any} actor @param {any} env @param {any} p @param {string} opId
 */
export async function vanRefund(db, trip, actor, env, p, opId) {
  await assertNotCounted(db, trip.id);
  if (trip.status !== "active") refuse("Trip is not on the road");
  const id = uuid(p.refundId);
  const [old] = await db`select * from sale_refunds where id=${id}`;
  if (old) {
    if (
      old.surface !== "van" ||
      old.trip_id !== trip.id ||
      canonicalJson(old.captured_request) !== canonicalJson(p)
    )
      refuse("Refund identifier was reused", "idempotency_conflict");
    return { entityId: id, movementId: old.movement_id };
  }
  const saleId = uuid(p.originalSale?.saleId);
  const [s] =
    await db`select * from van_sales where id=${saleId} and trip_id=${trip.id} for update`;
  if (!s || s.receipt_number !== p.originalSale.receiptNumber)
    refuse("Choose a receipt from this trip", "invalid_request");
  const [blocked] =
    await db`select (exists(select 1 from van_sale_voids where sale_id=${saleId}) or exists(select 1 from van_payments where sale_id=${saleId} and kind='collection')) as yes`;
  if (blocked.yes)
    refuse(
      "This sale was voided or already has a collection, so it cannot be refunded by item",
      "invalid_request",
    );
  const parts = paymentParts(s.receipt.payment);
  if (parts.some((x) => x?.kind === "credit"))
    refuse(
      "A sale on account cannot be refunded in cash. Ask the office to credit it.",
      "invalid_request",
    );
  const prior = await priorRefunds(db, saleId);
  // Stock already returned through the older whole-line return flow counts as taken back too.
  const legacy =
    await db`select l.product_id,sum(l.quantity_base)::text as qty from van_return_lines l join van_returns r on r.id=l.return_id where r.sale_id=${saleId} group by l.product_id`;
  /** @type {any[]} */ const soldLines = s.receipt.lines;
  for (const row of legacy) {
    const i = soldLines.findIndex((l) => l.productId === row.product_id);
    if (i >= 0)
      prior.byLine.set(i, (prior.byLine.get(i) ?? 0n) + BigInt(row.qty));
  }
  const oldRefunds =
    await db`select method,sum(amount_centavos)::text as amount from van_payments where sale_id=${saleId} and kind='refund' and not (facts ? 'refundId') group by method`;
  for (const row of oldRefunds)
    prior.byMethod.set(
      row.method,
      (prior.byMethod.get(row.method) ?? 0n) + BigInt(row.amount),
    );
  const plan = planRefund({
    receipt: s.receipt,
    prior: prior.byLine,
    picks: readPicks(p.lines),
  });
  if (integer(p.expectedMinor) !== plan.total)
    refuse(
      "The refund amount changed. Check the items and try again.",
      "stock_conflict",
    );
  const reason = await refundReason(
    db,
    p.reasonCode,
    p.note,
    trip.organization_id,
  );
  const policy = await refundPolicy(db, trip.organization_id);
  let approvalId = null;
  const [{ n: made }] =
    await db`select count(*)::int as n from sale_refunds where sale_id=${saleId}`;
  if (needsSupervisor(plan.total, policy.supervisorOverCentavos)) {
    if (p.refundNumber !== made + 1)
      refuse("Refunds of this receipt arrived out of order", "stock_conflict");
    approvalId = await consumeApproval(
      db,
      env,
      trip,
      "refund",
      refundApprovalFacts(s, plan.total, reason.code, made + 1),
      p.approval,
      opId,
    );
  }
  const tenders = refundTenders(
    parts.map((x) => ({
      method: x.method,
      label: x.label,
      amountCentavos: x.amountMinor,
    })),
    prior.byMethod,
    plan.total,
  );
  const [registration] =
    await db`select r.org_unit_id from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id where a.id=${uuid(p.fiscal?.allocationId)}`;
  if (!registration || registration.org_unit_id !== trip.org_unit_id)
    refuse("Credit memo range belongs to another branch");
  const document = await issueDocument(db, {
    actor,
    deviceId: trip.started_device_id,
    vehicleId: trip.vehicle_id,
    allocationId: p.fiscal.allocationId,
    serial: p.fiscal.serial,
    documentType: "credit_memo",
    sourceType: "van_refund",
    sourceId: id,
    at: p.deviceTime,
    snapshot: creditMemoSnapshot({
      surface: "van",
      receipt: s.receipt,
      originalNumber: s.receipt_number,
      saleId,
      refundId: id,
      plan,
      tenders,
      reason,
      cashier: actor.name,
      at: p.deviceTime,
    }),
  });
  if (document.document_number !== p.creditNumber)
    refuse("Credit memo number differs from its fiscal allocation");
  const status = reason.destination === "damaged" ? "damaged" : "available";
  /** @type {any[]} */ const stock = [];
  for (const o of plan.lines)
    stock.push(
      ...(await refundLotLines(db, {
        saleSource: "van_sale",
        saleId,
        productId: o.productId,
        locationId: trip.truck_location_id,
        quantity: o.quantityBase,
        status,
        uom: o.line.raw.uomCode ?? "PC",
      })),
    );
  const result = await postMovement(db, {
    kind: "pos_return",
    sourceType: "van_refund",
    sourceId: id,
    idempotencyKey: `van:${opId}`,
    occurredAt: Date.now(),
    actor: { profileId: actor.profileId, userId: actor.userId },
    organizationId: trip.organization_id,
    authorizedLocations: [
      trip.source_location_id,
      trip.truck_location_id,
    ].filter(Boolean),
    lines: stock,
  });
  await explainStock(
    db,
    trip,
    id,
    "return",
    plan.lines.map((o) => ({
      productId: o.productId,
      status,
      delta: o.quantityBase,
      facts: o.line.raw,
    })),
  );
  for (const t of tenders)
    await payment(
      db,
      trip,
      {
        method: t.method,
        label: t.label,
        amountMinor: String(t.amountCentavos),
        refundId: id,
      },
      "refund",
      saleId,
    );
  await enqueueSapPosting(db, document);
  await insertRefund(db, {
    id,
    surface: "van",
    saleId,
    originalNumber: s.receipt_number,
    tripId: trip.id,
    deviceId: trip.started_device_id,
    requestedBy: actor.profileId,
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
    movementId: result.movementId,
    captured: p,
    at: p.deviceTime,
  });
  await audit(db, trip, actor, "van.refund.recorded", id, {
    receiptNumber: s.receipt_number,
    creditNumber: document.document_number,
    totalMinor: String(plan.total),
    reasonCode: reason.code,
    approvalId,
  });
  return { entityId: id, movementId: result.movementId };
}
