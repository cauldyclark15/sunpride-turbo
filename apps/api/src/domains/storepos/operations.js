import { cashierContext, captureTime, registerFor } from "./model.js";
import { integer, uuid, refuse, choice, text } from "../van/model.js";
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
import { recordCashMovement } from "./cash.js";
import { useSupervisor } from "./overrides.js";
import { readingModel, generateZ, legacySnapshot } from "./readings.js";

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
  "store.cash",
  "store.override",
];
/** Ops a closed session may still send (reports, evidence, reprints). */
const AFTER_CLOSE = [
  "store.deposit",
  "store.customer",
  "store.print",
  "store.read",
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
    await db`select kind,closed_at from store_shift_closures where shift_id=${shift.id}`;
  const [day] =
    await db`select status from store_till_days where id=${shift.till_day_id}`;
  const dayDone = day?.status === "z_done";
  // An office force-close must not drop sales the cashier made before it, even if they sync later (SPEC 7.5).
  const lateButValid =
    closed?.kind === "forced" &&
    !dayDone &&
    c.op.opType === "store.sale" &&
    at <= +new Date(closed.closed_at);
  if (
    (closed || dayDone) &&
    !AFTER_CLOSE.includes(c.op.opType) &&
    !lateButValid
  )
    refuse("This session has closed its sales day");
  if (!closed && !dayDone) {
    const [event] =
      await db`select kind from store_session_events where shift_id=${shift.id} order by captured_at desc,created_at desc limit 1`;
    if (
      event?.kind === "suspended" &&
      !["store.customer", "store.print", "store.read"].includes(c.op.opType)
    )
      refuse("This session is on hold. Resume it first.");
  }
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
      if (p.reprint)
        await useSupervisor(ctx, {
          kind: "reprint",
          refType: "sale",
          refId: sale.id,
          reason: text(p.reason, 300, true),
          required: false,
        });
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
      // Supervisor PIN at the till: approve now, the office reviews the override afterwards (SPEC 7.3 step 6).
      const used = await useSupervisor(ctx, {
        kind: c.op.opType === "store.void" ? "void_sale" : "refund",
        refType: "sale",
        refId: sale.id,
        amountCentavos: String(sale.receipt.totalMinor),
        reason: text(p.reason, 300, true),
        required: false,
      });
      if (used)
        await decideReversal(db, used.supervisor, { id, decision: "approved" });
      return { entityId: id };
    }
    case "store.read":
      return read(ctx);
    case "store.cash":
      return recordCashMovement(ctx, { id: uuid(c.op.clientOpId) });
    case "store.override": {
      // A supervisor approval that has no document of its own yet: line void, price, discount, reprint, no sale.
      const kind = choice(p.kind, [
        "void_line",
        "price",
        "discount",
        "reprint",
      ]);
      const used = await useSupervisor(ctx, {
        kind,
        refType: text(p.refType, 40, true) ?? "sale",
        refId: text(p.refId, 100, true) ?? "",
        amountCentavos:
          p.amountCentavos == null ? null : String(integer(p.amountCentavos)),
        reason: text(p.reason, 300, true),
        required: true,
      });
      return { entityId: used?.overrideId ?? uuid(c.op.clientOpId) };
    }
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
export { expectedCash } from "./cash.js";
/** X (read-only, resets nothing) and Z (supervisor, after every session is closed) print the same typed model.
 * @param {any} c */
async function read(c) {
  const { db, register: r, shift, payload: p } = c;
  const kind = choice(p.kind, ["x", "z"]);
  const id = uuid(c.op.clientOpId);
  if (kind === "z") {
    // IP-INT2FIX: phones in the field (beta.25/26/hh1) send the Z with no supervisor proof. That request keeps working:
    // it is accepted only when the day has nothing left to settle (generateZ refuses open sessions and pending voids)
    // and it leaves a `z_legacy_no_pin` override row naming the cashier. A request that carries a proof stays strict.
    if (p.supervisor == null) {
      await generateZ(db, r, c.actor, {
        dayId: shift.till_day_id,
        readId: id,
        at: c.now,
      });
      await db`insert into store_overrides(id,register_id,till_day_id,shift_id,kind,method,supervisor_profile_id,cashier_profile_id,reason,ref_type,ref_id,captured_at) values(${crypto.randomUUID()},${r.id},${shift.till_day_id},${shift.id},'z_legacy_no_pin','legacy_no_pin',${c.actor.profileId},${c.actor.profileId},${"Z reading from an older app build, no supervisor PIN"},'z_reading',${id},${new Date(c.now)})`;
      return { entityId: id };
    }
    const used = await useSupervisor(c, {
      kind: "z_reading",
      refType: "z_reading",
      refId: id,
      required: true,
      tillDayId: shift.till_day_id,
    });
    if (!used) refuse("A supervisor must approve the Z reading");
    await generateZ(db, r, used.supervisor, {
      dayId: shift.till_day_id,
      readId: id,
      at: c.now,
    });
    return { entityId: id };
  }
  const { model } = await readingModel(db, shift.till_day_id, "x");
  await db`insert into store_read_sequences(register_id,kind) values(${r.id},'x') on conflict do nothing`;
  const [counter] =
    await db`update store_read_sequences set next_number=next_number+1 where register_id=${r.id} and kind='x' returning next_number-1 as sequence`;
  await db`insert into store_reads(id,register_id,shift_id,kind,sequence,snapshot,captured_at) values(${id},${r.id},${shift.id},'x',${String(counter.sequence)},${{ ...legacySnapshot(model, "x", Number(counter.sequence)), model: { ...model, journal: undefined } }},${new Date(c.now)})`;
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
  const [typed] =
    await db`select cash_tender_centavos::text as cash from store_z_readings where read_id=${z.id}`;
  const amount = integer(p.amountCentavos, true),
    expected = BigInt(
      typed?.cash ??
        z.snapshot.tenders.find((/** @type {any} */ t) => t.method === "cash")
          ?.amount ??
        "0",
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
  const [day] =
    await db`select status from store_till_days where id=${shift.till_day_id}`;
  if (closed || day?.status === "z_done")
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
