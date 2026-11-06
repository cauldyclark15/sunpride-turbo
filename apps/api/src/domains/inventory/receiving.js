import { ApiError } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { nextDocNumber } from "../../core/docnum.js";
import {
  choice,
  id,
  integer,
  invalid,
  lines,
  locationGate,
  ORGANIZATION,
  productPolicy,
  text,
  visibleLocations,
} from "./common.js";
import { commands, post } from "./commands.js";
import { requireReason } from "./reasons.js";
import { presentStatus } from "./transfers.js";

/** @typedef {import('./posting.js').MovementLine} MovementLine */

/** @param {string} code */
const docLocation = (code) =>
  String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 20) || "LOC";
/** @param {any} v @param {string} name @param {number} [max] */
const optional = (v, name, max = 160) =>
  v == null || v === "" ? null : text(v, name, max);

/**
 * Multi-line goods receipt (SPEC 4.2): supplier, delivery receipt no., PO reference, many lines, rejected quantity with
 * a reason, batch and expiry. Products that need quality release, and batches already recalled, land On hold.
 * One post for the whole delivery (up to 100 lines).
 */
export function installReceivingCommands() {
  commands["receipts/post"] = {
    cap: "inventory.write",
    prepare: async (c, b) =>
      locationGate(c, "inventory.write", id(b.receivingLocationId)),
    run: async (c, b, loc) => {
      if (!loc.allows_receiving || !loc.active)
        invalid("This location cannot receive stock");
      const receiptId = crypto.randomUUID();
      const receiptType = choice(
        b.receiptType,
        ["purchase_order", "transfer", "return", "unplanned"],
        "unplanned",
      );
      const supplierName = optional(b.supplierName, "Supplier"),
        poRef = optional(b.purchaseOrderRef, "PO reference", 100),
        carrier = optional(b.carrierName, "Carrier");
      const number = await nextDocNumber(c.db, ORGANIZATION, {
        type: "RCV",
        locationCode: docLocation(loc.code),
        at: c.now,
      });
      const input = lines(b.lines);
      let held = 0,
        rejectedLines = 0;
      /** @type {MovementLine[]} */ const postingLines = [];
      /** @type {any[]} */ const rows = [];
      for (const l of input) {
        const accepted = integer(l.quantityBase ?? 0, "Accepted quantity", 0),
          rejected = integer(l.rejectedBase ?? 0, "Rejected quantity", 0);
        if (!accepted && !rejected)
          invalid("Each line needs a quantity received or a quantity rejected");
        const { product, policy, tracking } = await productPolicy(
          c.db,
          id(l.productId),
        );
        let rejectedReason = null;
        if (rejected > 0) {
          if (!l.rejectedReasonCode)
            invalid("Choose a reason for the rejected items");
          rejectedReason = (
            await requireReason(c.db, ORGANIZATION, l.rejectedReasonCode, {
              note: l.note,
              photoCount: Number(
                l.photoCount ?? (Array.isArray(l.photos) ? l.photos.length : 0),
              ),
            })
          ).code;
          rejectedLines++;
        }
        let lotId = null,
          lotHeld = false,
          lotNumber = null,
          expiresAt = null;
        if (tracking === "lot") {
          lotNumber = text(l.lotNumber, "Batch number", 100);
          const normalized = lotNumber.toUpperCase();
          if (policy?.expiry_date_required && l.expiresAt == null)
            invalid("This product requires an expiry date");
          if (policy?.manufacture_date_required && l.manufacturedAt == null)
            invalid("This product requires a manufacture date");
          if (l.expiresAt != null) integer(l.expiresAt, "Expiry date", 1);
          if (l.manufacturedAt != null)
            integer(l.manufacturedAt, "Manufacture date", 1);
          if (
            l.expiresAt &&
            (l.expiresAt <= c.now ||
              (l.manufacturedAt && l.expiresAt <= l.manufacturedAt))
          )
            invalid("Expiry must follow receipt and manufacture");
          expiresAt = l.expiresAt ?? null;
          const [old] =
            await c.db`select * from inventory_lots where organization_id=${ORGANIZATION} and product_id=${product.id} and normalized_lot_number=${normalized} for update`;
          if (old) {
            if (
              (old.expires_at ? new Date(old.expires_at).getTime() : null) !==
                (l.expiresAt ?? null) ||
              (old.manufactured_at
                ? new Date(old.manufactured_at).getTime()
                : null) !== (l.manufacturedAt ?? null) ||
              ["expired", "rejected"].includes(old.quality_status)
            )
              invalid(
                "The batch's dates or quality conflict with the existing batch",
              );
            lotId = old.id;
            const [hold] =
              await c.db`select 1 as x from inventory_lot_holds where lot_id=${old.id} and released_at is null limit 1`;
            lotHeld = Boolean(hold) || old.quality_status !== "released";
          } else {
            const [lot] =
              await c.db`insert into inventory_lots (organization_id,product_id,lot_number,normalized_lot_number,source_type,source_document_id,received_at,manufactured_at,expires_at,quality_status,unit_cost_minor) values (${ORGANIZATION},${product.id},${lotNumber},${normalized},${receiptType},${receiptId},${new Date(c.now)},${l.manufacturedAt ? new Date(l.manufacturedAt) : null},${l.expiresAt ? new Date(l.expiresAt) : null},${policy?.quality_release_required ? "pending" : "released"},${l.unitCostMinor ?? null}) returning id`;
            lotId = lot.id;
          }
        }
        // On hold: products that need quality release, and batches that are recalled or held. Never refused.
        const needsHold = Boolean(policy?.quality_release_required) || lotHeld;
        const destinationStatus = needsHold ? "quality_hold" : "available";
        if (needsHold && accepted > 0) held++;
        for (const [qty, status] of /** @type {Array<[number,string]>} */ ([
          [accepted, destinationStatus],
          [rejected, "rejected"],
        ]))
          if (qty)
            postingLines.push({
              productId: product.id,
              quantityBase: qty,
              uom: product.uom,
              fromLocationId: null,
              toLocationId: loc.id,
              stockStatus: status,
              lotId,
              ...(l.unitCostMinor != null
                ? { unitCostMinor: integer(l.unitCostMinor, "Cost") }
                : {}),
            });
        rows.push({
          product,
          accepted,
          rejected,
          lotId,
          destinationStatus,
          cost: l.unitCostMinor ?? null,
          rejectedReason,
          note: l.note ?? null,
          lotNumber,
          expiresAt,
        });
      }
      await c.db`insert into goods_receipts (id,organization_id,receipt_number,receipt_type,receiving_location_id,status,delivery_reference,received_by,note,supplier_name,purchase_order_ref,carrier_name,held_lines,rejected_lines) values (${receiptId},${ORGANIZATION},${number},${receiptType},${loc.id},'in_inspection',${b.deliveryReference ?? null},${c.actor.userId},${b.note ?? null},${supplierName},${poRef},${carrier},${held},${rejectedLines})`;
      for (const r of rows)
        await c.db`insert into goods_receipt_lines (organization_id,receipt_id,product_id,accepted_base,rejected_base,lot_id,destination_status,unit_cost_minor,rejected_reason_code,note,lot_number,expires_at) values (${ORGANIZATION},${receiptId},${r.product.id},${r.accepted},${r.rejected},${r.lotId},${r.destinationStatus},${r.cost},${r.rejectedReason},${r.note},${r.lotNumber},${r.expiresAt ? new Date(r.expiresAt) : null})`;
      const movement = await post(
        c,
        b,
        c.openingStock ? "opening_balance" : "goods_receipt",
        c.openingStock ? "cutover" : "goods_receipt",
        receiptId,
        postingLines,
      );
      await c.db`update goods_receipts set status='posted',movement_id=${movement.movementId} where id=${receiptId}`;
      return {
        id: receiptId,
        number,
        lineCount: rows.length,
        heldLines: held,
        rejectedLines,
        ...movement,
      };
    },
  };
}

// ---------------------------------------------------------------- reads

/** Receive queue (SPEC 4.2 step 1): expected deliveries, inbound transfers, van load-ins.
 * There is no purchase-order feed yet (SAP owns purchasing), so expected deliveries stay empty and
 * "Unplanned delivery" is a button on the screen. @param {any} ctx */
async function queueRoute(ctx) {
  await requireCapability(ctx, "inventory.read");
  const locations = await visibleLocations(ctx);
  const ids = locations.map((l) => l.id);
  if (!ids.length)
    return {
      expectedDeliveries: [],
      inboundTransfers: [],
      vanLoadIns: [],
      locations: [],
    };
  const transfers =
    await ctx.db`select t.*,s.name as source_name,d.name as destination_name from stock_transfers t
    join inventory_locations s on s.id=t.source_location_id join inventory_locations d on d.id=t.destination_location_id
    where t.organization_id=${ORGANIZATION} and t.status in ('shipped','partially_received','review_needed','review_required')
    and (t.destination_location_id in ${ctx.db(ids)} or t.source_location_id in ${ctx.db(ids)}) order by t.dispatched_at nulls last,t.created_at limit 200`;
  const lineTotals =
    await ctx.db`select transfer_id,count(*)::int as lines,sum(shipped_base)::text as dispatched,sum(received_base)::text as received from stock_transfer_lines where transfer_id in ${ctx.db(transfers.length ? transfers.map((/** @type {any} */ t) => t.id) : ["00000000-0000-0000-0000-000000000000"])} group by transfer_id`;
  const shape = (/** @type {any} */ t) => {
    const totals = lineTotals.find(
      (/** @type {any} */ x) => x.transfer_id === t.id,
    );
    return {
      id: t.id,
      number: t.transfer_number,
      type: t.type,
      status: presentStatus(t.status),
      from: t.source_name,
      to: t.destination_name,
      toLocationId: t.destination_location_id,
      driverName: t.driver_name,
      vehiclePlate: t.vehicle_plate,
      dispatchedAt: t.dispatched_at,
      lineCount: totals?.lines ?? 0,
      dispatchedBase: Number(totals?.dispatched ?? 0),
      receivedBase: Number(totals?.received ?? 0),
      waitingForDecision: ["review_needed", "review_required"].includes(
        t.status,
      ),
    };
  };
  const inbound = transfers.filter(
    (/** @type {any} */ t) =>
      t.type !== "van_load_in" && ids.includes(t.destination_location_id),
  );
  const loadIns = transfers.filter(
    (/** @type {any} */ t) =>
      t.type === "van_load_in" && ids.includes(t.destination_location_id),
  );
  // Trucks that have counted their stock and are waiting for the clerk to receive it.
  const waiting =
    await ctx.db`select o.id as observation_id,t.id as trip_id,t.trip_number,t.truck_location_id,t.source_location_id,o.captured_at,l.name as truck_name
    from van_trip_observations o join van_trips t on t.id=o.trip_id join inventory_locations l on l.id=t.truck_location_id
    where o.kind='unload' and t.organization_id=${ORGANIZATION} and t.source_location_id in ${ctx.db(ids)}
    and not exists (select 1 from van_observation_decisions d where d.observation_id=o.id) order by o.captured_at limit 100`;
  return {
    expectedDeliveries: [],
    expectedDeliveriesNote:
      "No purchase orders are linked yet. Use Unplanned delivery to receive a supplier delivery.",
    inboundTransfers: inbound.map(shape),
    vanLoadIns: [
      ...waiting.map((/** @type {any} */ w) => ({
        observationId: w.observation_id,
        tripId: w.trip_id,
        tripNumber: w.trip_number,
        truck: w.truck_name,
        countedAt: w.captured_at,
        status: "waiting_for_clerk",
      })),
      ...loadIns.map(shape),
    ],
    locations: locations
      .filter(
        (l) =>
          l.allows_receiving &&
          l.active &&
          !["truck", "in_transit"].includes(l.type),
      )
      .map((l) => ({ id: l.id, code: l.code, name: l.name, type: l.type })),
  };
}

/** @param {any} ctx */
async function receiptsRoute(ctx) {
  await requireCapability(ctx, "inventory.read");
  const ids = new Set((await visibleLocations(ctx)).map((l) => l.id));
  const q = ctx.url.searchParams;
  const one = q.get("id");
  const rows = one
    ? await ctx.db`select * from goods_receipts where organization_id=${ORGANIZATION} and id=${id(one)}`
    : await ctx.db`select * from goods_receipts where organization_id=${ORGANIZATION} order by created_at desc limit 200`;
  const out = [];
  for (const r of rows) {
    if (!ids.has(r.receiving_location_id)) continue;
    const ls = one
      ? await ctx.db`select g.*,p.code,p.name from goods_receipt_lines g join products p on p.id=g.product_id where g.receipt_id=${r.id} order by g.created_at,g.id`
      : [];
    out.push({
      id: r.id,
      number: r.receipt_number,
      status: r.status,
      type: r.receipt_type,
      supplierName: r.supplier_name,
      deliveryReceiptNo: r.delivery_reference,
      purchaseOrderRef: r.purchase_order_ref,
      carrierName: r.carrier_name,
      receivingLocationId: r.receiving_location_id,
      heldLines: r.held_lines,
      rejectedLines: r.rejected_lines,
      note: r.note,
      createdAt: r.created_at,
      lines: ls.map((/** @type {any} */ g) => ({
        id: g.id,
        productId: g.product_id,
        code: g.code,
        name: g.name,
        acceptedBase: Number(g.accepted_base),
        rejectedBase: Number(g.rejected_base),
        rejectedReasonCode: g.rejected_reason_code,
        batch: g.lot_number,
        expiresAt: g.expires_at ? new Date(g.expires_at).getTime() : null,
        destinationStatus: g.destination_status,
        unitCostMinor:
          g.unit_cost_minor == null ? null : Number(g.unit_cost_minor),
      })),
    });
  }
  if (one && !out.length)
    throw new ApiError("not_found", 404, "Receipt not found");
  return one ? out[0] : { receipts: out };
}

/** @param {import('../../core/router.js').Router} router */
export function installReceivingRoutes(router) {
  router.get("/api/v1/inventory/receive/queue", queueRoute);
  router.get("/api/v1/inventory/receipts/list", receiptsRoute);
}
