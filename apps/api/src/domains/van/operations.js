import { postMovement } from "../inventory/posting.js";
import { resolvePrice, creditCheck } from "../orders/pricing.js";
import { currentDeviceActor, tripFor, outletFor } from "./access.js";
import { damagePhoto } from "./media.js";
import {
  audit,
  productFor,
  frozenProduct,
  explainStock,
  expectedStock,
  cashExpectation,
  assertNotCounted,
  assertTruckStock,
  payment,
} from "./facts.js";
import { consumeApproval, stockCountCode } from "./approvals.js";
import {
  integer,
  safeNumber,
  uuid,
  text,
  rows,
  choice,
  refuse,
  today,
  dayString,
  extend,
  LOAD_REASONS,
  DAMAGE_REASONS,
  DAMAGE_POLICY,
  PAYMENT_METHODS,
  VOID_REASONS,
  STOCK_VARIANCE_REASONS,
  CASH_VARIANCE_REASONS,
} from "./model.js";
import { canonicalJson } from "../../core/util.js";
import { ApiError } from "../../core/errors.js";
import { OP_CODES } from "../../core/sync.js";

export const VAN_OPS = [
  "trip.start",
  "load.confirm",
  "truck.damage",
  "sale.record",
  "sale.void",
  "return.record",
  "payment.record",
  "cash.reconcile",
  "stock.reconcile",
  "trip.close",
];
/** @param {any} db @param {any} trip @param {any} actor @param {string} kind @param {string} id @param {any[]} lines @param {string} key */
export async function movement(db, trip, actor, kind, id, lines, key) {
  const nonzero = lines
    .filter((l) => BigInt(l.quantityBase) > 0n)
    .map((l) => ({ ...l, quantityBase: safeNumber(l.quantityBase) }));
  if (!nonzero.length) return null;
  const result = await postMovement(db, {
    kind,
    sourceType:
      /** @type {Record<string,string>} */ ({
        van_load: "van_trip_load",
        pos_sale: "van_sale",
        pos_void: "van_sale_void",
        pos_return: "van_return",
        status_change: "van_damage_record",
        reversal: "van_damage_record",
        inventory_adjustment: "van_stock_count",
        van_unload: "van_trip",
      })[kind] ?? "van_trip",
    sourceId: id,
    idempotencyKey: `van:${key}`,
    occurredAt: Date.now(),
    actor: { profileId: actor.profileId, userId: actor.userId },
    organizationId: trip.organization_id,
    // The trip's depot and truck were scope-checked when the office planned it; a territory
    // seller is not in scope for an area depot, but may move stock between exactly these two.
    authorizedLocations: [
      trip.source_location_id,
      trip.truck_location_id,
    ].filter(Boolean),
    lines: nonzero,
  });
  return result.movementId;
}
/** In-place truck status change; posting allocates the source lots and keeps them. @param {any} trip @param {any} l @param {bigint} quantity @param {string} from @param {string} to */
export const statusLine = (trip, l, quantity, from, to) => ({
  productId: l.productId,
  fromLocationId: trip.truck_location_id,
  toLocationId: trip.truck_location_id,
  quantityBase: quantity,
  uom: l.uomCode ?? l.facts?.uomCode ?? "PC",
  fromStockStatus: from,
  toStockStatus: to,
  lotId: l.lotId ?? null,
});
/** @param {any} trip @param {any} l @param {bigint} quantity @param {boolean} inward @param {string} [status] */
const stockLine = (trip, l, quantity, inward, status = "available") => ({
  productId: l.productId,
  fromLocationId: inward ? null : trip.truck_location_id,
  toLocationId: inward ? trip.truck_location_id : null,
  quantityBase: quantity,
  uom: l.uomCode ?? l.facts?.uomCode ?? "PC",
  stockStatus: status,
  lotId: l.lotId ?? null,
});
/** @param {any} db @param {any} trip @param {any} actor */
export async function finishLoad(db, trip, actor) {
  const [load] =
    await db`select * from van_trip_loads where trip_id=${trip.id} and status in ('planned','discrepancy') and deleted_at is null for update`;
  if (!load) refuse("Load is not waiting for posting");
  /** @type {any[]} */ const lines =
    await db`select * from van_trip_load_lines where load_id=${load.id} and deleted_at is null order by line_number`;
  const movementId = await movement(
    db,
    trip,
    actor,
    "van_load",
    load.id,
    lines.map((l) => ({
      productId: l.product_id,
      fromLocationId: trip.source_location_id,
      toLocationId: trip.truck_location_id,
      quantityBase: BigInt(l.actual_base ?? l.expected_base),
      uom: l.uom_code,
      lotId: l.lot_id,
      stockStatus: "available",
    })),
    `load:${load.id}`,
  );
  if (!movementId)
    refuse("A load needs a positive quantity", "invalid_request");
  await db`update van_trip_loads set status='posted',movement_id=${movementId},updated_at=now() where id=${load.id}`;
  await db`update van_trips set status='loaded',updated_at=now() where id=${trip.id}`;
  await explainStock(
    db,
    trip,
    load.id,
    "load",
    lines.map((l) => ({
      productId: l.product_id,
      delta: BigInt(l.actual_base ?? l.expected_base),
    })),
  );
  return { entityId: load.id, movementId };
}
/** @param {any} ctx @param {any} env */
export async function applyOperation(ctx, env) {
  try {
    return await dispatchOperation(ctx, env);
  } catch (error) {
    if (error instanceof ApiError && [400, 409, 422].includes(error.status)) {
      return ctx.reject(
        OP_CODES.includes(error.code)
          ? error.code
          : error.status === 409
            ? "stock_conflict"
            : "invalid_request",
      );
    }
    throw error;
  }
}
/** @param {any} ctx @param {any} env */
async function dispatchOperation(ctx, env) {
  const { db, payload: p, op } = ctx;
  const { actor, device } = await currentDeviceActor(
    db,
    ctx.actor,
    ctx.device.id,
  );
  const trip = await tripFor(db, actor, uuid(p.tripId), "van.operate", true);
  if (
    trip.salesperson_profile_id !== actor.profileId ||
    trip.salesperson_subject !== actor.subject ||
    (trip.started_device_id && trip.started_device_id !== device.id)
  )
    refuse("This trip belongs to another seller or device", "out_of_scope");
  if (dayString(trip.service_date) !== today(ctx.now))
    refuse("This trip is not for today", "wrong_date");
  if (
    !Number.isSafeInteger(p.deviceTime) ||
    p.deviceTime !== op.clientTime ||
    today(p.deviceTime) !== dayString(trip.service_date) ||
    p.deviceTime > ctx.now + 60000
  )
    refuse("Capture time is outside the trip day", "wrong_date");
  if (["closed", "cancelled"].includes(trip.status)) refuse("Trip is closed");
  if (
    !["load.confirm", "trip.start"].includes(op.opType) &&
    !["active", "closing", "reconciling", "review_required"].includes(
      trip.status,
    )
  )
    refuse("Start the trip before recording operations");
  if (["cash.reconcile", "stock.reconcile"].includes(op.opType)) {
    if (
      (
        await db`select 1 from van_damage_records where trip_id=${trip.id} and status='pending_approval'`
      ).length
    )
      refuse(
        "Decide pending damage before counting",
        "evidence_pending_review",
      );
    const prior =
      op.opType === "cash.reconcile"
        ? await db`select 1 from van_cash_counts where trip_id=${trip.id}`
        : await db`select 1 from van_stock_counts where trip_id=${trip.id}`;
    if (prior.length)
      refuse("This trip already has a count", "idempotency_conflict");
  }
  /** @type {any} */ let result;
  switch (op.opType) {
    case "trip.start": {
      const [load] =
        await db`select status from van_trip_loads where trip_id=${trip.id} and deleted_at is null`;
      if (trip.status !== "loaded" || load?.status !== "posted")
        refuse("Post the load before departure", "load_not_posted");
      if (p.vehicleConfirmed !== true || p.routeConfirmed !== true)
        refuse("Confirm the truck and route", "invalid_request");
      if (
        p.odometerKm !== undefined &&
        (!Number.isFinite(p.odometerKm) || p.odometerKm < 0)
      )
        refuse("Invalid odometer", "invalid_request");
      await db`update van_trips set status='active',started_at=now(),started_device_id=${device.id},driver_name=coalesce(${text(p.driverName, 80)},driver_name),helper_name=coalesce(${text(p.helperName, 80)},helper_name),start_odometer_km=${p.odometerKm ?? null},start_note=${text(p.note)},updated_at=now() where id=${trip.id}`;
      result = { entityId: trip.id };
      break;
    }
    case "load.confirm": {
      const [load] =
        await db`select * from van_trip_loads where id=${uuid(p.loadId)} and trip_id=${trip.id} and deleted_at is null for update`;
      if (!load || load.status !== "planned" || trip.status !== "loading")
        refuse("Load cannot be confirmed now");
      /** @type {any[]} */ const lines =
        await db`select * from van_trip_load_lines where load_id=${load.id} and deleted_at is null order by line_number`;
      const supplied = rows(p.lines);
      if (supplied.length !== lines.length)
        refuse("Count every load line", "invalid_request");
      const seen = new Set();
      let differs = false;
      for (const input of supplied) {
        const line = lines.find((l) => l.line_number === input.lineNumber);
        if (!line || seen.has(input.lineNumber))
          refuse("Load line is missing or repeated", "invalid_request");
        seen.add(input.lineNumber);
        const actual = integer(input.actualBase),
          changed = actual !== BigInt(line.expected_base);
        const reason = changed ? choice(input.reason, LOAD_REASONS) : null;
        differs ||= changed;
        await db`update van_trip_load_lines set actual_base=${String(actual)},discrepancy_reason=${reason},updated_at=now() where id=${line.id}`;
      }
      await db`update van_trip_loads set confirmed_by=${actor.subject},confirmed_at=now(),confirmed_device_id=${device.id},confirm_request_id=${op.clientOpId},updated_at=now() where id=${load.id}`;
      if (differs) {
        await db`update van_trip_loads set status='discrepancy' where id=${load.id}`;
        result = { entityId: load.id };
      } else result = await finishLoad(db, trip, actor);
      break;
    }
    case "truck.damage": {
      if (trip.status !== "active")
        refuse("Start the trip before recording damage");
      await assertNotCounted(db, trip.id);
      const product = await productFor(db, uuid(p.productId));
      const qty = integer(p.quantityBase, true);
      const reason = choice(p.reason, DAMAGE_REASONS);
      const approval =
        qty >= BigInt(DAMAGE_POLICY.approvalFromUnits) * product.quantityScale;
      const photoId = await damagePhoto(
        db,
        actor,
        device,
        trip,
        p.photoSha256,
        approval || DAMAGE_POLICY.photoRequiredReasons.includes(reason),
      );
      const id = crypto.randomUUID(),
        facts = frozenProduct(product);
      const movementId = await movement(
        db,
        trip,
        actor,
        "status_change",
        id,
        // One in-place status change keeps the same lots: available → damaged on the truck.
        // (Two lines via "outside" left the inward line without a lot for lot-tracked stock.)
        [statusLine(trip, facts, qty, "available", "damaged")],
        op.clientOpId,
      );
      await db`insert into van_damage_records(id,organization_id,trip_id,org_unit_id,truck_location_id,product_id,product_code,uom_code,quantity_scale,quantity_base,reason,note,photo_id,needs_approval,status,recorded_by,recorded_profile_id,device_id,client_request_id,recorded_at,movement_id)
        values(${id},${trip.organization_id},${trip.id},${trip.org_unit_id},${trip.truck_location_id},${product.id},${product.code},${product.base_code},${String(product.quantityScale)},${String(qty)},${reason},${text(p.note)},${photoId},${approval},${approval ? "pending_approval" : "recorded"},${actor.subject},${actor.profileId},${device.id},${op.clientOpId},now(),${movementId})`;
      if (photoId)
        await db`update van_damage_photos set damage_record_id=${id} where id=${photoId}`;
      await explainStock(db, trip, id, "damage", [
        { productId: product.id, delta: -qty, facts },
        { productId: product.id, status: "damaged", delta: qty, facts },
      ]);
      result = { entityId: id, movementId };
      break;
    }
    case "sale.record":
      result = await sale(db, trip, actor, p, op.clientOpId);
      break;
    case "sale.void":
      result = await voidSale(db, trip, actor, env, p, op.clientOpId);
      break;
    case "return.record":
      result = await customerReturn(db, trip, actor, p, op.clientOpId);
      break;
    case "payment.record": {
      await assertNotCounted(db, trip.id);
      if (trip.status !== "active") refuse("Trip is not on the road");
      const saleId = uuid(p.saleId);
      const [s] =
        await db`select * from van_sales where id=${saleId} and trip_id=${trip.id} for update`;
      if (!s || s.receipt.payment.kind !== "credit")
        refuse("Choose a credit sale from this trip", "invalid_request");
      const amount = integer(p.amountMinor, true),
        method = choice(p.method, ["cash", "check", "gcash", "bank_transfer"]);
      const [r] =
        await db`select coalesce(sum(amount_centavos),0)::text as paid from van_payments where sale_id=${saleId} and kind='collection'`;
      if (BigInt(r.paid) + amount > BigInt(s.total_centavos))
        refuse(
          "Collection exceeds the remaining credit sale",
          "invalid_request",
        );
      if (method !== "cash") text(p.reference, 100, true);
      const id = await payment(
        db,
        trip,
        { ...p, method },
        "collection",
        saleId,
      );
      result = { entityId: id };
      break;
    }
    case "cash.reconcile":
      result = await countCash(db, trip, env, p, op.clientOpId);
      break;
    case "stock.reconcile":
      result = await countStock(db, trip, actor, env, p, op.clientOpId);
      break;
    case "trip.close":
      result = await closeTrip(db, trip, actor, p, op.clientOpId);
      break;
    default:
      refuse("Unsupported operation", "unsupported_operation");
  }
  await audit(db, trip, actor, op.opType, result.entityId, {
    clientOpId: op.clientOpId,
  });
  // A coalesced durable job runs the analytics seam only after this tx commits.
  await ctx.enqueue({
    kind: "van.refresh",
    key: `van:${trip.org_unit_id}:${dayString(trip.service_date)}`,
    payload: { date: dayString(trip.service_date), unitId: trip.org_unit_id },
  });
  await ctx.change("van.bundle", actor.profileId, `profile:${actor.profileId}`);
  ctx.publish("van");
  return result;
}
/** @param {any} db @param {any} trip @param {any} actor @param {any} p @param {string} opId */
async function sale(db, trip, actor, p, opId) {
  await assertNotCounted(db, trip.id);
  if (trip.status !== "active") refuse("Start the trip before selling");
  const saleId = uuid(p.saleId);
  const [prior] = await db`select * from van_sales where id=${saleId}`;
  if (prior) {
    if (
      prior.trip_id !== trip.id ||
      canonicalJson(prior.captured_request) !== canonicalJson(p)
    )
      refuse(
        "Sale identifier was reused with different facts",
        "idempotency_conflict",
      );
    return { entityId: saleId };
  }
  const receiptNumber = text(p.receiptNumber, 100, true);
  if (
    !receiptNumber?.startsWith(trip.trip_number + "-") ||
    !/^.+-[0-9A-F]{8}-\d{4,9}$/.test(receiptNumber)
  )
    refuse("Receipt does not belong to this trip", "invalid_request");
  if (p.currency !== "PHP")
    refuse("Only PHP sales are supported", "invalid_request");
  if (!p.customer?.outletId)
    refuse(
      "Choose an authorized store; walk-in pricing needs setup",
      "invalid_request",
    );
  const customer = await outletFor(db, actor, p.customer.outletId);
  const at = Number(p.deviceTime),
    quoted = [];
  let total = 0n,
    discounts = 0n;
  const seen = new Set();
  for (const [i, l] of rows(p.lines).entries()) {
    const product = await productFor(db, uuid(l.productId), at);
    if (seen.has(product.id))
      refuse("Each product appears once per sale", "invalid_request");
    seen.add(product.id);
    const qty = integer(l.quantityBase, true);
    const paid = l.paidBase === undefined ? qty : integer(l.paidBase),
      free = l.freeBase === undefined ? 0n : integer(l.freeBase);
    if (paid + free !== qty || free !== 0n)
      refuse(
        "Promotion approval is not supported by the pricing seam",
        "invalid_request",
      );
    const price = await resolvePrice(db, {
      organizationId: trip.organization_id,
      productId: product.id,
      uom: product.base_code,
      channelKey: customer.channel,
      customerCode: customer.customerCode,
      at,
    });
    if (price.unitPriceCentavos === null)
      refuse("This product has no governed selling price", "invalid_request");
    const unitPrice = BigInt(safeNumber(price.unitPriceCentavos));
    if (integer(l.unitPriceMinor) !== unitPrice)
      refuse("The selling price changed", "stock_conflict");
    const gross = extend(unitPrice, paid, product.quantityScale),
      discount = integer(l.discountMinor ?? "0");
    // Fail closed: the frozen protocol has no governed promotion evaluator or discount capability seam.
    if (discount !== 0n || l.promotion)
      refuse("Discount needs a governed promotion", "invalid_request");
    const lineTotal = gross - discount;
    if (
      integer(l.totalMinor) !== lineTotal ||
      (l.grossMinor !== undefined && integer(l.grossMinor) !== gross)
    )
      refuse("Sale totals do not reconcile", "invalid_request");
    total += lineTotal;
    discounts += discount;
    quoted.push({
      ...frozenProduct(product),
      lineNumber: i + 1,
      quantityBase: String(qty),
      unitPriceMinor: String(unitPrice),
      totalMinor: String(lineTotal),
      discountMinor: String(discount),
      priceListId: price.priceListId,
      priceSource: price.source,
    });
  }
  safeNumber(total);
  if (integer(p.totalMinor) !== total)
    refuse("Sale total does not reconcile", "invalid_request");
  const pay = p.payment;
  if (!pay || integer(pay.amountMinor) !== total)
    refuse("Payment must match the sale total", "invalid_request");
  const method = PAYMENT_METHODS.find((m) => m.code === pay.method);
  if (!method || pay.kind !== method.kind)
    refuse("Payment method is invalid", "invalid_request");
  if (method.referenceRequired) text(pay.reference, 100, true);
  if (method.kind === "cash") {
    const tender = integer(pay.tenderedMinor);
    if (tender < total || integer(pay.changeMinor) !== tender - total)
      refuse("Cash and change do not reconcile", "invalid_request");
  }
  if (method.kind === "credit") {
    if (!customer.customerCode)
      refuse("Credit account needs setup", "invalid_request");
    await db`select id from customers where code=${customer.customerCode} for update`;
    const [terms] =
      await db`select * from outlet_credit_terms where outlet_id=${customer.id} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) and deleted_at is null`;
    if (!terms || terms.currency !== "PHP")
      refuse("Credit terms need setup", "invalid_request");
    const credit = await creditCheck(db, {
      customerCode: customer.customerCode,
      addCentavos: safeNumber(total),
    });
    const [pending] =
      await db`select coalesce(sum(s.total_centavos),0)::text as total from van_sales s where s.customer_code=${customer.customerCode} and s.receipt->'payment'->>'kind'='credit' and not exists(select 1 from van_sale_voids v where v.sale_id=s.id)`;
    if (
      credit.status !== "within" ||
      credit.limit === null ||
      credit.exposure === null ||
      BigInt(credit.exposure) + BigInt(pending.total) + total >
        BigInt(credit.limit) ||
      BigInt(pending.total) + total > BigInt(terms.credit_limit_minor)
    )
      refuse("Credit cannot be certified within limit", "stock_conflict");
    const due = new Date(at + terms.terms_days * 86400000);
    const dueDate = today(due.getTime());
    if (pay.dueDate !== dueDate)
      refuse(
        "Credit due date does not match the governed terms",
        "invalid_request",
      );
  }
  const [truck] =
    await db`select vehicle_code,plate_number,name from vehicles where id=${trip.vehicle_id}`;
  const receipt = {
    saleId,
    receiptNumber,
    customer: {
      name: customer.name,
      code: customer.code,
      address: customer.address,
    },
    seller: { name: actor.name },
    truck: {
      code: truck.vehicle_code,
      plateNumber: truck.plate_number,
      name: truck.name,
    },
    tripNumber: trip.trip_number,
    currency: "PHP",
    totalMinor: String(total),
    discountMinor: String(discounts),
    lines: quoted,
    payment: { ...pay, label: method.label },
    soldAt: at,
  };
  await db`insert into van_sales(id,trip_id,receipt_number,outlet_id,customer_code,total_centavos,discount_centavos,receipt,captured_request) values(${saleId},${trip.id},${receiptNumber},${customer.id},${customer.customerCode},${String(total)},${String(discounts)},${receipt},${p})`;
  for (const l of quoted)
    await db`insert into van_sale_lines(sale_id,ordinal,product_id,quantity_base,total_centavos,facts) values(${saleId},${l.lineNumber},${l.productId},${l.quantityBase},${l.totalMinor},${l})`;
  await payment(db, trip, pay, "sale", saleId);
  const movementId = await movement(
    db,
    trip,
    actor,
    "pos_sale",
    saleId,
    quoted.map((l) => stockLine(trip, l, BigInt(l.quantityBase), false)),
    opId,
  );
  await explainStock(
    db,
    trip,
    saleId,
    "sale",
    quoted.map((l) => ({
      productId: l.productId,
      delta: -BigInt(l.quantityBase),
      facts: l,
    })),
  );
  return { entityId: saleId, movementId };
}
/** @param {any} db @param {any} trip @param {any} actor @param {any} env @param {any} p @param {string} opId */
async function voidSale(db, trip, actor, env, p, opId) {
  await assertNotCounted(db, trip.id);
  const id = uuid(p.saleId);
  const [s] =
    await db`select * from van_sales where id=${id} and trip_id=${trip.id} for update`;
  if (
    !s ||
    s.receipt_number !== p.receiptNumber ||
    BigInt(s.total_centavos) !== integer(p.totalMinor)
  )
    refuse("Receipt facts do not match", "invalid_request");
  const [used] =
    await db`select (exists(select 1 from van_sale_voids where sale_id=${id}) or exists(select 1 from van_returns where sale_id=${id}) or exists(select 1 from van_payments where sale_id=${id} and kind='collection')) as yes`;
  if (used.yes)
    refuse("This sale has already been voided, returned or collected");
  const facts = {
    receiptNumber: s.receipt_number,
    totalMinor: String(s.total_centavos),
    reasonCode: choice(p.reasonCode, VOID_REASONS),
  };
  const approvalId = await consumeApproval(
    db,
    env,
    trip,
    "void",
    facts,
    p.approval,
    opId,
  );
  const [v] =
    await db`insert into van_sale_voids(sale_id,trip_id,reason,approval_id) values(${id},${trip.id},${facts.reasonCode},${approvalId}) returning id`;
  /** @type {any[]} */ const lines = s.receipt.lines;
  const movementId = await movement(
    db,
    trip,
    actor,
    "pos_void",
    v.id,
    lines.map((l) => stockLine(trip, l, BigInt(l.quantityBase), true)),
    opId,
  );
  await explainStock(
    db,
    trip,
    v.id,
    "void",
    lines.map((l) => ({
      productId: l.productId,
      delta: BigInt(l.quantityBase),
      facts: l,
    })),
  );
  await payment(db, trip, s.receipt.payment, "void_refund", id);
  return { entityId: v.id, movementId };
}
/** @param {any} db @param {any} trip @param {any} actor @param {any} p @param {string} opId */
async function customerReturn(db, trip, actor, p, opId) {
  await assertNotCounted(db, trip.id);
  if (trip.status !== "active") refuse("Trip is not on the road");
  const id = uuid(p.returnId);
  const [prior] = await db`select * from van_returns where id=${id}`;
  if (prior) {
    if (
      prior.trip_id !== trip.id ||
      canonicalJson(prior.captured_request) !== canonicalJson(p)
    )
      refuse("Return identifier was reused", "idempotency_conflict");
    return { entityId: id };
  }
  const saleId = uuid(p.originalSale?.saleId);
  const [s] =
    await db`select * from van_sales where id=${saleId} and trip_id=${trip.id} for update`;
  if (
    !s ||
    s.receipt_number !== p.originalSale.receiptNumber ||
    p.customer?.outletId !== s.outlet_id
  )
    refuse("Link the original receipt and customer", "invalid_request");
  if ((await db`select 1 from van_sale_voids where sale_id=${saleId}`).length)
    refuse("A voided sale cannot be returned");
  const input = rows(p.lines),
    seen = new Set();
  for (const l of input) {
    uuid(l.productId);
    if (seen.has(l.productId))
      refuse("Each returned product appears once", "invalid_request");
    seen.add(l.productId);
    const original = s.receipt.lines.find(
      (/** @type {any} */ l2) => l2.productId === l.productId,
    );
    if (!original)
      refuse("Product was not on the original receipt", "invalid_request");
    const qty = integer(l.quantityBase, true);
    const [r] =
      await db`select coalesce(sum(l.quantity_base),0)::text as qty from van_return_lines l join van_returns r on r.id=l.return_id where r.sale_id=${saleId} and l.product_id=${l.productId}`;
    if (BigInt(r.qty) + qty > BigInt(original.quantityBase))
      refuse("Returned quantity exceeds the original sale", "invalid_request");
    const reason = choice(l.reason, [
      "damaged",
      "expired",
      "spoiled",
      "near_expiry",
      "quality_complaint",
      "wrong_item",
      "overstock",
    ]);
    const disposition = choice(l.disposition, [
      "resellable",
      "bad_stock",
      "disposed_at_outlet",
    ]);
    if (
      ["expired", "spoiled", "near_expiry", "quality_complaint"].includes(
        reason,
      )
    )
      text(l.lotNumber, 80, true);
    if (
      ["damaged", "expired", "spoiled"].includes(reason) &&
      disposition === "resellable"
    )
      refuse(
        "This reason cannot return goods to sellable stock",
        "invalid_request",
      );
    const approvalRequired =
      disposition === "disposed_at_outlet" ||
      reason === "quality_complaint" ||
      (reason === "near_expiry" && disposition === "resellable");
    if (approvalRequired)
      refuse(
        "This return needs an office disposition workflow",
        "evidence_pending_review",
      );
    const effect = disposition === "resellable" ? "available" : "damaged";
    if (l.stockEffect !== effect)
      refuse("Return disposition and stock effect disagree", "invalid_request");
    if (l.approvalRequired === true || p.approval?.required === true)
      refuse(
        "This return needs an office disposition workflow",
        "evidence_pending_review",
      );
    // Never use refreshed master facts for a linked receipt.
    l.frozen = original;
  }
  const captured = { ...p, lines: input.map(({ frozen, ...l }) => l) };
  await db`insert into van_returns(id,trip_id,sale_id,return_number,captured_request) values(${id},${trip.id},${saleId},${text(p.returnNumber, 100, true)},${captured})`;
  for (const [i, l] of input.entries())
    await db`insert into van_return_lines(return_id,ordinal,product_id,quantity_base,stock_status,facts) values(${id},${i + 1},${l.productId},${l.quantityBase},${l.stockEffect},${{ ...l, product: l.frozen }})`;
  const posting = input.filter((l) => l.stockEffect !== "none");
  const movementId = await movement(
    db,
    trip,
    actor,
    "pos_return",
    id,
    posting.map((l) =>
      stockLine(trip, l.frozen, BigInt(l.quantityBase), true, l.stockEffect),
    ),
    opId,
  );
  await explainStock(
    db,
    trip,
    id,
    "return",
    posting.map((l) => ({
      productId: l.productId,
      status: l.stockEffect,
      delta: BigInt(l.quantityBase),
      facts: l.frozen,
    })),
  );
  // Refunds are explicit additions to the frozen return protocol; never infer money from a stock return.
  if (p.refund) {
    const amount = integer(p.refund.amountMinor),
      max = input.reduce(
        (a, l) =>
          a +
          extend(
            BigInt(l.frozen.totalMinor),
            BigInt(l.quantityBase),
            BigInt(l.frozen.quantityBase),
          ),
        0n,
      );
    const [r] =
      await db`select coalesce(sum(amount_centavos),0)::text as refunded from van_payments where sale_id=${saleId} and kind='refund'`;
    if (
      amount > max ||
      BigInt(r.refunded) + amount > BigInt(s.total_centavos) ||
      s.receipt.payment.kind === "credit"
    )
      refuse("Refund exceeds the paid returned goods", "invalid_request");
    choice(p.refund.method, [s.receipt.payment.method]);
    await payment(db, trip, p.refund, "refund", saleId, id);
  }
  return { entityId: id, movementId };
}
/** @param {any} db @param {any} trip @param {any} env @param {any} p @param {string} opId */
async function countCash(db, trip, env, p, opId) {
  const id = uuid(p.reconciliationId),
    expected = await cashExpectation(db, trip.id);
  if (expected !== integer(p.expectedMinor))
    refuse("Expected cash changed", "stock_conflict");
  const allowed = [
    100000n,
    50000n,
    20000n,
    10000n,
    5000n,
    2000n,
    1000n,
    500n,
    100n,
    25n,
    10n,
    5n,
    1n,
  ];
  const seen = new Set();
  let declared = 0n;
  if (!Array.isArray(p.counts) || p.counts.length > allowed.length)
    refuse("Count supported PHP denominations", "invalid_request");
  for (const c of p.counts) {
    const d = integer(c.denominationMinor, true);
    if (!allowed.includes(d) || seen.has(c.denominationMinor))
      refuse("Denomination is invalid or repeated", "invalid_request");
    seen.add(c.denominationMinor);
    declared += d * integer(c.count);
  }
  safeNumber(declared);
  if (declared !== integer(p.declaredMinor) || p.currency !== "PHP")
    refuse("Cash count does not reconcile", "invalid_request");
  const variance = declared - expected;
  let approvalId = null;
  if (variance !== 0n) choice(p.reasonCode, CASH_VARIANCE_REASONS);
  if (variance > 5000n || variance < -5000n)
    approvalId = await consumeApproval(
      db,
      env,
      trip,
      "cash",
      {
        expectedMinor: String(expected),
        declaredMinor: String(declared),
        reasonCode: p.reasonCode,
      },
      p.approval,
      opId,
    );
  await db`insert into van_cash_counts(id,trip_id,expected_centavos,declared_centavos,variance_centavos,approval_id,facts) values(${id},${trip.id},${String(expected)},${String(declared)},${String(variance)},${approvalId},${{ counts: p.counts, reasonCode: p.reasonCode ?? null, note: text(p.note) }})`;
  await db`update van_trips set status='reconciling' where id=${trip.id}`;
  return { entityId: id };
}
/** @param {any} db @param {any} trip @param {any} actor @param {any} env @param {any} p @param {string} opId */
async function countStock(db, trip, actor, env, p, opId) {
  const id = uuid(p.reconciliationId),
    expected = await expectedStock(db, trip.id),
    input = rows(p.lines, 1000);
  await assertTruckStock(db, trip, expected);
  if (input.length !== expected.length)
    refuse("Count every stock line", "invalid_request");
  const seen = new Set();
  let short = 0n,
    over = 0n,
    differing = 0;
  for (const l of input) {
    const e = expected.find(
        (e) => e.productId === l.productId && e.status === l.status,
      ),
      key = `${l.productId}:${l.status}`;
    if (!e || seen.has(key) || integer(l.expectedBase) !== e.expectedBase)
      refuse("Expected stock changed or count is incomplete", "stock_conflict");
    seen.add(key);
    const delta = integer(l.countedBase) - e.expectedBase;
    if (delta) {
      choice(l.reasonCode, STOCK_VARIANCE_REASONS);
      differing++;
      if (delta < 0n) short -= delta;
      else over += delta;
    }
  }
  const countCode = stockCountCode(trip.id, id, input);
  if (
    p.countCode !== countCode ||
    p.varianceLines !== differing ||
    integer(p.shortBase) !== short ||
    integer(p.overBase) !== over
  )
    refuse("Count fingerprint does not match the lines", "invalid_request");
  const approvalId = differing
    ? await consumeApproval(
        db,
        env,
        trip,
        "stock",
        {
          countCode,
          varianceLines: differing,
          shortBase: String(short),
          overBase: String(over),
        },
        p.approval,
        opId,
      )
    : null;
  await db`insert into van_stock_counts(id,trip_id,count_code,variance_lines,short_base,over_base,approval_id,facts) values(${id},${trip.id},${countCode},${differing},${String(short)},${String(over)},${approvalId},${{ note: text(p.note) }})`;
  const postings = [],
    explanations = [];
  for (const l of input) {
    const e = expected.find(
        (e) => e.productId === l.productId && e.status === l.status,
      ),
      delta = BigInt(l.countedBase) - e.expectedBase;
    const [balance] =
      await db`select weighted_average_cost_minor from inventory_balances where product_id=${l.productId} and location_id=${trip.truck_location_id} and deleted_at is null`;
    const cost =
      balance?.weighted_average_cost_minor === null ||
      balance?.weighted_average_cost_minor === undefined
        ? null
        : extend(
            BigInt(balance.weighted_average_cost_minor),
            delta < 0n ? -delta : delta,
            BigInt(e.facts.quantityScale),
          ) * (delta < 0n ? -1n : 1n);
    await db`insert into van_stock_count_lines(count_id,product_id,stock_status,expected_base,counted_base,variance_base,value_centavos,facts) values(${id},${l.productId},${l.status},${String(e.expectedBase)},${l.countedBase},${String(delta)},${cost === null ? null : String(cost)},${{ ...e.facts, reasonCode: l.reasonCode }})`;
    if (delta) {
      postings.push(
        stockLine(
          trip,
          e.facts,
          delta < 0n ? -delta : delta,
          delta > 0n,
          l.status,
        ),
      );
      explanations.push({
        productId: l.productId,
        status: l.status,
        delta,
        facts: e.facts,
      });
    }
  }
  const movementId = await movement(
    db,
    trip,
    actor,
    "inventory_adjustment",
    id,
    postings,
    opId,
  );
  await assertTruckStock(
    db,
    trip,
    input.map((l) => ({ ...l, expectedBase: BigInt(l.countedBase) })),
  );
  await explainStock(db, trip, id, "count_adjustment", explanations);
  await db`update van_trips set status='reconciling' where id=${trip.id}`;
  return { entityId: id, movementId };
}
/** @param {any} db @param {any} trip @param {any} actor @param {any} p @param {string} opId */
async function closeTrip(db, trip, actor, p, opId) {
  uuid(p.closeId);
  const [cash] =
    await db`select * from van_cash_counts where trip_id=${trip.id}`;
  const [stock] =
    await db`select * from van_stock_counts where trip_id=${trip.id}`;
  if (!cash || !stock) refuse("Count cash and stock before closing");
  if (
    !(await db`select 1 from van_cash_remittances where trip_id=${trip.id}`)
      .length
  )
    refuse("The office must confirm receipt of the cash before closing");
  if (
    (
      await db`select 1 from van_damage_records where trip_id=${trip.id} and status='pending_approval'`
    ).length
  )
    refuse(
      "A supervisor must decide the damage first",
      "evidence_pending_review",
    );
  if (
    (BigInt(cash.variance_centavos) !== 0n || stock.variance_lines > 0) &&
    p.exceptionsReviewed !== true
  )
    refuse("Review the cash and stock differences");
  if (!Array.isArray(p.operations) || p.operations.length > 5000)
    refuse("Include the trip operation manifest", "invalid_request");
  const known =
    await db`select details->>'clientOpId' as id from van_audit_events where trip_id=${trip.id} and details ? 'clientOpId'`;
  const manifestIds = new Set(
    p.operations.map((/** @type {any} */ o) => o.clientRequestId),
  );
  if (
    manifestIds.size !== known.length ||
    known.some((/** @type {any} */ row) => !manifestIds.has(row.id))
  )
    refuse(
      "Trip manifest must include every accepted trip operation",
      "dependency_missing",
    );
  for (const o of p.operations) {
    const id = uuid(o.clientRequestId);
    const [r] =
      await db`select op_type from op_receipts where subject=${actor.subject} and device_id=${trip.started_device_id} and client_op_id=${id} and status='applied'`;
    if (!r || r.op_type !== o.kind)
      refuse(
        "Some trip operations have not reached the office",
        "dependency_missing",
      );
  }
  if (
    p.endOdometerKm !== undefined &&
    (!Number.isFinite(p.endOdometerKm) ||
      p.endOdometerKm < (trip.start_odometer_km ?? 0))
  )
    refuse("End odometer is invalid", "invalid_request");
  const current = await expectedStock(db, trip.id);
  await assertTruckStock(db, trip, current);
  const movementId = await movement(
    db,
    trip,
    actor,
    "van_unload",
    trip.id,
    current
      .filter((l) => l.expectedBase > 0n)
      .map((l) => ({
        ...stockLine(trip, l.facts, l.expectedBase, false, l.status),
        toLocationId: trip.source_location_id,
      })),
    opId,
  );
  await explainStock(
    db,
    trip,
    p.closeId,
    "unload",
    current.map((l) => ({ ...l, delta: -l.expectedBase })),
  );
  await assertTruckStock(db, trip, []);
  await db`update van_trips set status='closed',closed_at=now(),updated_at=now() where id=${trip.id}`;
  await audit(db, trip, actor, "van.trip.close_facts", p.closeId, {
    endOdometerKm: p.endOdometerKm ?? null,
    note: text(p.note),
    operations: p.operations.length,
    exceptionsReviewed: p.exceptionsReviewed === true,
  });
  return { entityId: trip.id, movementId };
}
