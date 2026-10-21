import { cashierContext, captureTime, registerFor } from "./model.js";
import { integer, uuid, refuse, choice, text, today } from "../van/model.js";
import { recordSale, canonicalOrder, phone } from "./commercial.js";
import { postMovement } from "../inventory/posting.js";
import { commands as inventory } from "../inventory/commands.js";
import { actorFor } from "../../core/context.js";
import {
  allocateDocumentNumber,
  issueDocument,
  documentEvent,
} from "../fiscal/series.js";
import { enqueueSapPosting } from "../fiscal/transactions.js";

export const STORE_OPS = [
  "store.sale",
  "store.void",
  "store.refund",
  "store.read",
  "store.receive",
  "store.count",
  "store.deposit",
  "store.customer",
  "store.print",
];
/** F-R01..R07: every offline write enters the existing signed push transaction. @param {any} c */
export async function storeOperation(c) {
  const at = captureTime(c),
    fresh = await cashierContext(c.db, c.actor, c.device, at);
  const { register: r, actor, mode } = fresh;
  const { db, payload: p } = c;
  if (p.registerId !== r.id || p.modeVersionId !== mode.id)
    refuse("Sync the current register configuration");
  await db`select set_config('sunpride.actor',${actor.userId},true)`;
  const [shift] =
    await db`select * from store_shifts where id=${uuid(p.shiftId)} and register_id=${r.id} and device_id=${fresh.device.id} and cashier_id=${actor.profileId} for update`;
  if (!shift || at < +new Date(shift.opened_at))
    refuse("Open your cashier session first");
  const [closed] =
    await db`select 1 from store_shift_closures where shift_id=${shift.id}`;
  const [z] =
    await db`select 1 from store_reads where shift_id=${shift.id} and kind='z'`;
  if (
    (closed || z) &&
    !["store.deposit", "store.customer", "store.print"].includes(c.op.opType)
  )
    refuse("This session has closed its sales day");
  const [policy] =
    await db`select * from store_register_policies where id=${shift.policy_id}`;
  const ctx = { ...c, ...fresh, shift, policy, now: at };
  switch (c.op.opType) {
    case "store.sale":
      return recordSale(ctx);
    case "store.print": {
      const [sale] =
        await db`select s.* from store_sales s join store_shifts h on h.id=s.shift_id where s.id=${uuid(p.saleId)} and h.register_id=${r.id}`;
      if (!sale) refuse("Choose a saved receipt from this store");
      const result = await documentEvent(db, actor, {
        documentId: sale.fiscal_document_id,
        kind: p.reprint ? "reprint" : "print",
        reason: text(p.reason, 300, true),
        requestKey: c.op.clientOpId,
        outcome: "uncertain",
      });
      return { entityId: result.id };
    }
    case "store.void":
    case "store.refund": {
      const [sale] =
        await db`select s.*,h.register_id from store_sales s join store_shifts h on h.id=s.shift_id where s.id=${uuid(p.saleId)} for update of s`;
      if (!sale || sale.register_id !== r.id)
        refuse("Choose a receipt from this store");
      if (c.op.opType === "store.void" && sale.shift_id !== shift.id)
        refuse(
          "Void only during the original cashier session; request a refund instead",
        );
      const id = uuid(c.op.clientOpId);
      await db`insert into store_reversals(id,sale_id,shift_id,kind,reason,requested_by,status,request) values(${id},${sale.id},${shift.id},${c.op.opType === "store.void" ? "void" : "refund"},${text(p.reason, 300, true)},${actor.profileId},'pending',${p})`;
      return { entityId: id };
    }
    case "store.read":
      return read(ctx);
    case "store.receive":
      return receive(ctx);
    case "store.count":
      return count(ctx);
    case "store.deposit":
      return deposit(ctx);
    case "store.customer": {
      const number = phone(p.phone);
      const name = text(p.name, 100, true);
      const [old] =
        await db`select * from store_customers where phone=${number}`;
      if (old && old.name !== name)
        refuse("That phone is already registered; use customer lookup");
      const [row] =
        await db`insert into store_customers(phone,name) values(${number},${name}) on conflict(phone) do update set phone=excluded.phone returning id`;
      return { entityId: row.id };
    }
    default:
      refuse("Unsupported store action");
  }
}
/** F-R01 shared tender journal drives cash; never trust a phone-supplied expected amount.
 * @param {any} db @param {string} shiftId */
export async function expectedCash(db, shiftId) {
  const [r] =
    await db`select s.opening_centavos+coalesce((select sum(t.amount_centavos) from store_tenders t where t.shift_id=s.id and t.method='cash'),0) as expected from store_shifts s where s.id=${shiftId}`;
  return BigInt(r.expected);
}
/** F-R02 immutable X/Z reads, monotonic per-register counters, canonical order totals and frozen VAT.
 * @param {any} c */
async function read(c) {
  const { db, register: r, shift, payload: p } = c;
  const kind = choice(p.kind, ["x", "z"]);
  const [pending] =
    await db`select 1 from store_reversals where shift_id=${shift.id} and status='pending'`;
  if (pending && kind === "z")
    refuse("Decide pending voids/refunds before Z closing");
  const sales =
    await db`select s.*,o.status from store_sales s join orders o on o.id=s.order_id join store_shifts h on h.id=s.shift_id where h.register_id=${r.id} and h.service_date=${today(p.deviceTime)} order by s.sold_at,s.id`;
  const tenders =
    await db`select method,max(label) as label,sum(amount_centavos)::text as amount from store_tenders t join store_shifts h on h.id=t.shift_id where h.register_id=${r.id} and h.service_date=${today(p.deviceTime)} group by method order by method`;
  const credits =
    await db`select v.*,s.receipt from store_reversals v join store_sales s on s.id=v.sale_id join store_shifts h on h.id=v.shift_id where h.register_id=${r.id} and h.service_date=${today(p.deviceTime)} and v.status='approved' and v.kind='refund'`;
  let total = 0n;
  /** @type {Record<string,bigint>} */
  const vat = {
    vatableSalesMinor: 0n,
    vatMinor: 0n,
    vatExemptMinor: 0n,
    zeroRatedMinor: 0n,
  };
  const journal = [];
  for (const s of sales) {
    journal.push({
      number: s.receipt_number,
      status: s.status,
      snapshot: s.receipt,
    });
    if (s.status === "voided") continue;
    total += BigInt(s.receipt.totalMinor);
    for (const k of Object.keys(vat)) vat[k] += BigInt(s.receipt.tax[k]);
  }
  for (const s of credits) {
    total -= BigInt(s.receipt.totalMinor);
    for (const k of Object.keys(vat)) vat[k] -= BigInt(s.receipt.tax[k]);
    journal.push({
      kind: "refund",
      original: s.receipt.receiptNumber,
      amount: s.receipt.totalMinor,
    });
  }
  await db`insert into store_read_sequences(register_id,kind) values(${r.id},${kind}) on conflict do nothing`;
  const [counter] =
    await db`update store_read_sequences set next_number=next_number+1 where register_id=${r.id} and kind=${kind} returning next_number-1 as sequence`;
  const snapshot = {
    kind,
    sequence: String(counter.sequence),
    store: r.store_name,
    register: r.name,
    date: today(p.deviceTime),
    salesCentavos: String(total),
    basketCount: sales.filter((/** @type {any} */ s) => s.status !== "voided")
      .length,
    tenders,
    vat: Object.fromEntries(
      Object.entries(vat).map(([k, v]) => [k, String(v)]),
    ),
    journal,
    sample: sales.some((/** @type {any} */ s) => s.receipt.fiscal?.sample),
    notice:
      "BIR reporting uses the configured fiscal authorization; sample series is not a filed PTU.",
  };
  const id = uuid(c.op.clientOpId);
  await db`insert into store_reads(id,register_id,shift_id,kind,sequence,snapshot,captured_at) values(${id},${r.id},${shift.id},${kind},${String(counter.sequence)},${snapshot},${new Date(p.deviceTime)})`;
  return { entityId: id };
}
/** F-R04 SEAM(INVENTORY): delegate to canonical receiving/count commands after register authorization.
 * @param {any} c */
async function receive(c) {
  const { db, register: r, payload: p } = c;
  const body = { ...p, idempotencyKey: c.op.clientOpId };
  if (p.transferId) {
    const [transfer] =
      await db`select * from stock_transfers where id=${uuid(p.transferId)} and destination_location_id=${r.location_id} for update`;
    if (!transfer) refuse("Choose a shipped transfer to this store");
    const result = await inventory["transfers/receive"].run(
      {
        ...c,
        authorizedLocations: [transfer.in_transit_location_id, r.location_id],
      },
      body,
      transfer,
    );
    return { entityId: result.id, movementId: result.movementId };
  }
  const ref = text(p.purchaseOrder, 100, true);
  const [location] =
    await db`select * from inventory_locations where id=${r.location_id}`;
  const result = await inventory["receipts/post"].run(
    c,
    {
      ...body,
      receiptType: "purchase_order",
      deliveryReference: ref,
      receivingLocationId: r.location_id,
    },
    location,
  );
  return { entityId: result.id, movementId: result.movementId };
}
/** F-R04 full/cycle blind capture freezes canonical versions; independent approval owns variance posting. @param {any} c */
async function count(c) {
  const { db, register: r, payload: p } = c;
  if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 100)
    refuse("Count 1–100 stock lines");
  const [location] =
    await db`select * from inventory_locations where id=${r.location_id}`;
  const started = await inventory["counts/start"].run(
    c,
    {
      countType: choice(p.countType, ["full", "cycle"]),
      blindCount: true,
      ...(p.countType === "cycle"
        ? {
            productIds: [
              ...new Set(p.lines.map((/** @type {any} */ l) => l.productId)),
            ],
          }
        : {}),
    },
    location,
  );
  const [session] =
    await db`select * from stock_count_sessions where id=${started.id}`;
  const rows =
    await db`select * from stock_count_lines where session_id=${session.id}`;
  const selected =
    p.countType === "full"
      ? rows
      : rows.filter((/** @type {any} */ x) =>
          p.lines.some((/** @type {any} */ l) => l.productId === x.product_id),
        );
  // The canonical full-session writer requires every frozen stock/status/lot line, even for a cycle.
  if (selected.length !== rows.length || rows.length !== p.lines.length)
    refuse(
      "Count every listed stock/status/lot line; narrow the store count first",
    );
  const entries = rows.map((/** @type {any} */ row) => {
    const line = p.lines.find(
      (/** @type {any} */ l) =>
        l.productId === row.product_id &&
        (l.lotId ?? null) === row.lot_id &&
        (l.stockStatus ?? "available") === row.stock_status,
    );
    if (!line || String(line.version) !== String(row.snapshot_balance_version))
      refuse(
        "Stock changed since download; refresh the count",
        "stale_snapshot",
      );
    return { lineId: row.id, countedBase: Number(integer(line.countedBase)) };
  });
  await inventory["counts/submit"].run(
    c,
    { lines: entries, idempotencyKey: c.op.clientOpId },
    session,
  );
  return { entityId: session.id };
}
/** F-R06: bind uploaded evidence to this cashier/device/register and exactly one immutable Z. @param {any} c */
async function deposit(c) {
  const { db, register: r, actor, device, payload: p } = c;
  const [z] =
    await db`select * from store_reads where id=${uuid(p.zReadId)} and register_id=${r.id} and kind='z'`;
  if (!z) refuse("Choose this store’s Z-read");
  const [file] =
    await db`select * from files where sha256=${text(p.photoSha256, 64, true)} and purpose='bank-deposit' and owner_id=${r.id} and device_id=${device.id} and created_by=${actor.userId} and status='stored'`;
  if (!file) refuse("Upload the deposit-slip photo first");
  const amount = integer(p.amountCentavos, true),
    expected = BigInt(
      z.snapshot.tenders.find((/** @type {any} */ t) => t.method === "cash")
        ?.amount ?? "0",
    );
  const diff = amount - expected;
  const id = uuid(c.op.clientOpId);
  await db`insert into store_deposits(id,register_id,shift_id,bank,reference,amount_centavos,photo_id,z_read_id,expected_centavos,discrepancy_centavos,status,requested_by) values(${id},${r.id},${c.shift.id},${text(p.bank, 100, true)},${text(p.reference, 100, true)},${String(amount)},${file.id},${z.id},${String(expected)},${String(diff)},${diff === 0n ? "matched" : "needs_review"},${actor.profileId})`;
  return { entityId: id };
}
/** F-R03: independently approved full-receipt reversal; original sale and receipt never rewritten.
 * @param {any} db @param {any} actor @param {any} p */
export async function decideReversal(db, actor, p) {
  const [request] =
    await db`select * from store_reversals where id=${uuid(p.id)} for update`;
  if (
    !request ||
    request.status !== "pending" ||
    request.requested_by === actor.profileId
  )
    refuse("A second person must decide a pending reversal");
  const [sale] =
    await db`select * from store_sales where id=${request.sale_id}`;
  const [shift] =
    await db`select * from store_shifts where id=${request.shift_id}`;
  const r = await registerFor(db, actor, shift.register_id, "van.cash.approve");
  const decision = choice(p.decision, ["approved", "rejected"]);
  if (decision === "rejected") {
    await db`update store_reversals set status='rejected',decided_by=${actor.profileId} where id=${request.id}`;
    return { id: request.id };
  }
  const [closed] =
    await db`select 1 from store_shift_closures where shift_id=${shift.id}`;
  const [z] =
    await db`select 1 from store_reads where shift_id=${shift.id} and kind='z'`;
  if (closed || z)
    refuse("Request a refund in an open session; this day has already closed");
  const original =
    await db`select l.*,a.lot_id,a.quantity_base as allocated from inventory_movement_lines l left join inventory_allocations a on a.movement_line_id=l.id where l.movement_id=${sale.movement_id}`;
  const movement = await postMovement(db, {
    kind: request.kind === "void" ? "pos_void" : "pos_return",
    sourceType: "store_reversal",
    sourceId: request.id,
    idempotencyKey: `store-reverse:${request.id}`,
    occurredAt: Date.now(),
    organizationId: r.organization_id,
    actor: { profileId: actor.profileId, userId: actor.userId },
    lines: original.map((/** @type {any} */ l) => ({
      productId: l.product_id,
      fromLocationId: null,
      toLocationId: r.location_id,
      quantityBase: Number(l.allocated ?? l.quantity_base),
      lotId: l.lot_id,
      uom: "base",
      toStockStatus: request.kind === "refund" ? "quality_hold" : "available",
      unitCostMinor: Number(l.unit_cost_minor ?? 0),
    })),
  });
  const [order] = await db`select * from orders where id=${sale.order_id}`;
  if (request.kind === "void") {
    await db`update orders set status='voided',voided_at=now(),voided_by=${actor.subject},void_movement_id=${movement.movementId} where id=${order.id}`;
    await db`insert into fiscal_document_events(document_id,kind,request_key,reason,actor_profile_id,facts) values(${sale.fiscal_document_id},'void',${request.id},${request.reason},${actor.profileId},${{ storeApproval: request.id }})`;
  } else {
    const id = request.id;
    const lines = sale.receipt.lines.map((/** @type {any} */ l) => ({
      ...l,
      quantity: -l.quantity,
      quantityBase: -l.quantityBase,
      lineTotalCentavos: -l.lineTotalCentavos,
    }));
    const at = Date.now();
    const [series] =
      await db`select s.id from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${r.org_unit_id} and r.document_type='credit_memo' and s.vehicle_id is null and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now())`;
    if (!series) refuse("Configure a credit-memo series in Fiscal setup");
    const issuer = await actorFor(
      db,
      (await db`select user_id from profiles where id=${shift.cashier_id}`)[0]
        .user_id,
    );
    const allocation = await allocateDocumentNumber(db, {
      actor: issuer,
      deviceId: shift.device_id,
      seriesId: series.id,
      requestKey: id,
      count: 1,
    });
    const document = await issueDocument(db, {
      actor: issuer,
      deviceId: shift.device_id,
      vehicleId: null,
      allocationId: allocation.allocationId,
      serial: allocation.firstSerial,
      documentType: "credit_memo",
      sourceType: "store_refund",
      sourceId: id,
      at,
      snapshot: {
        ...sale.receipt,
        originalInvoice: sale.receipt_number,
        approvedBy: actor.name,
        reason: request.reason,
      },
    });
    await canonicalOrder(
      { db, actor, register: r, payload: { deviceTime: at } },
      {
        id,
        number: document.document_number,
        customerCode: order.customer_code,
        outletId: order.outlet_id,
        channel: order.channel_key,
        total: -Number(order.total_centavos),
        lines,
        movementId: movement.movementId,
        originalId: order.id,
        salespersonId: order.salesperson_profile_id,
        salespersonSubject: order.salesperson_subject,
      },
    );
    await enqueueSapPosting(db, document);
  }
  const tenders =
    await db`select * from store_tenders where sale_id=${sale.id} and amount_centavos>0`;
  for (const t of tenders)
    await db`insert into store_tenders(shift_id,sale_id,operation_id,method,reference,amount_centavos,label,status) values(${shift.id},${sale.id},${request.id},${t.method},${t.reference},${String(-BigInt(t.amount_centavos))},${t.label},'reversed')`;
  const points =
    await db`select customer_id,sum(delta) as delta from store_points where sale_id=${sale.id} group by customer_id`;
  for (const point of points)
    await db`insert into store_points(customer_id,sale_id,delta,kind) values(${point.customer_id},${sale.id},${String(-BigInt(point.delta))},'reverse')`;
  await db`update store_reversals set status='approved',decided_by=${actor.profileId},movement_id=${movement.movementId},order_id=${request.kind === "refund" ? request.id : null} where id=${request.id}`;
  return { id: request.id };
}
