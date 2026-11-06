import { ApiError } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { nextDocNumber } from "../../core/docnum.js";
import {
  choice,
  document,
  gateTransfer,
  id,
  integer,
  invalid,
  locationGate,
  notSelf,
  ORGANIZATION,
  productPolicy,
  state,
  text,
  visibleLocations,
} from "./common.js";
import { postMovement } from "./posting.js";
import { commands } from "./commands.js";
import { requireReason } from "./reasons.js";
import { toleranceFor, withinTolerance } from "./tolerances.js";
import { unitInfo } from "./units.js";

/**
 * One movement document (SPEC 5.1) for depot transfers, store replenishment, van load-out, van reload,
 * van load-in, return to depot and recall pull. Every stock change goes through postMovement.
 * The stored status "shipped" is what people see as "In transit" (dispatched).
 * Core functions take `c = {db, actor, now, trusted?}` so the van domain can call them from its own transactions.
 * @typedef {{db:any, actor:any, now:number, trusted?:boolean}} Ctx
 * @typedef {import('./posting.js').MovementLine} MovementLine
 */

export const TRANSFER_TYPES = /** @type {const} */ ([
  "depot_transfer",
  "store_replenishment",
  "van_load_out",
  "van_reload",
  "van_load_in",
  "return_to_depot",
  "recall_pull",
]);
export const TRANSFER_TYPE_LABELS = /** @type {Record<string,string>} */ ({
  depot_transfer: "Depot transfer",
  store_replenishment: "Store replenishment",
  van_load_out: "Van load-out",
  van_reload: "Van reload",
  van_load_in: "Van load-in",
  return_to_depot: "Return to depot",
  recall_pull: "Recall pull",
});
const DOC_TYPE = /** @type {Record<string,string>} */ ({
  van_load_out: "LOAD",
  van_reload: "RLD",
  van_load_in: "LIN",
});
const CHARGE_TO = [
  "dispatch_side",
  "receive_side",
  "carrier",
  "driver",
  "none",
];
const OPEN_VARIANCE_STATES = ["review_needed", "review_required"];

/** Shown name for a stored status. @param {string} status */
export const presentStatus = (status) =>
  status === "shipped"
    ? "dispatched"
    : status === "review_required"
      ? "review_needed"
      : status;

/** @param {string} code @returns {string} */
function docLocation(code) {
  const c = String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 20);
  return c || "LOC";
}
/** @param {Ctx} c @param {string} suffix @param {{idempotencyKey:string,note?:string}} b @param {string} kind @param {string} sourceType @param {string} sourceId @param {MovementLine[]} lines @param {string[]} [authorized] */
const move = (c, b, suffix, kind, sourceType, sourceId, lines, authorized) =>
  postMovement(c.db, {
    kind,
    sourceType,
    sourceId,
    idempotencyKey: `posting:${b.idempotencyKey}:${suffix}`,
    occurredAt: c.now,
    actor: { profileId: c.actor.profileId, userId: c.actor.userId },
    organizationId: ORGANIZATION,
    lines,
    ...(authorized?.length
      ? { authorizedLocations: authorized.slice(0, 4) }
      : {}),
    ...(b.note ? { note: b.note } : {}),
  });
/** @param {any} v @param {string} name */
const optionalText = (v, name) =>
  v == null || v === "" ? null : text(v, name, 160);

/** @param {Ctx} c @param {string} locationId @param {string} cap */
async function loadLocation(c, locationId, cap) {
  if (!c.trusted) return locationGate(c, cap, id(locationId));
  const [row] =
    await c.db`select * from inventory_locations where id=${id(locationId)} and organization_id=${ORGANIZATION} and deleted_at is null`;
  if (!row) throw new ApiError("not_found", 404, "Stock location not found");
  return row;
}
/** One in-transit location per depot; made on first use so stock in transit never sits on a truck or shelf.
 * @param {any} db @param {any} depot */
export async function transitLocationFor(db, depot) {
  const [t] =
    await db`select * from inventory_locations where organization_id=${ORGANIZATION} and type='in_transit' and active and deleted_at is null and org_unit_id is not distinct from ${depot.org_unit_id} order by code limit 1`;
  if (t) return t;
  const code = `TRANSIT-${docLocation(depot.code)}`.slice(0, 60);
  const [made] =
    await db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
    values (${ORGANIZATION},${depot.org_unit_id},${depot.site_code},${code},${`In transit - ${depot.name}`},'in_transit',true,false,false,false,false)
    on conflict do nothing returning *`;
  if (made) return made;
  const [again] =
    await db`select * from inventory_locations where organization_id=${ORGANIZATION} and code=${code}`;
  if (!again) invalid("No in-transit location is set up for this depot");
  return again;
}
/** @param {string} type */
const toleranceEvent = (type) =>
  type === "van_load_in"
    ? "load_in_difference"
    : type === "van_load_out"
      ? "load_out_difference"
      : "transfer_receive_variance";
/** @param {number|bigint|string} cost @param {number|bigint|string} qty @param {number|bigint|string} scale */
const valueOf = (cost, qty, scale) =>
  (BigInt(cost) * BigInt(qty)) / BigInt(scale || 1);
/** @param {any} db @param {string} transferId */
const allocationsOf = (db, transferId) =>
  db`select a.*,l.lot_number,l.expires_at,l.quality_status,
    exists(select 1 from inventory_lot_holds h where h.lot_id=a.lot_id and h.released_at is null) as recall_held
    from stock_transfer_allocations a left join inventory_lots l on l.id=a.lot_id
    where a.transfer_id=${transferId} order by a.seq`;
/** @param {any} db @param {string} transferId */
const linesOf = (db, transferId) =>
  db`select * from stock_transfer_lines where transfer_id=${transferId} order by seq`;
/** @param {any} a an allocation row */
const posted = (a) =>
  Number(a.received_good_base) +
  Number(a.received_damaged_base) +
  Number(a.received_hold_base);
/** @param {any} a */
const heldLot = (a) =>
  Boolean(a.recall_held) ||
  (a.lot_id != null && a.quality_status !== "released");

/** Reload line totals from their batches (legacy columns stay in step: received_base = everything counted in).
 * @param {Ctx} c @param {string} transferId */
async function refreshLines(c, transferId) {
  const allocs = await allocationsOf(c.db, transferId);
  for (const l of await linesOf(c.db, transferId)) {
    const mine = allocs.filter(
      (/** @type {any} */ a) => a.transfer_line_id === l.id,
    );
    const sum = (/** @type {string} */ k) =>
      mine.reduce(
        (/** @type {number} */ n, /** @type {any} */ a) => n + Number(a[k]),
        0,
      );
    const good = sum("received_good_base"),
      damaged = sum("received_damaged_base"),
      hold = sum("received_hold_base");
    await c.db`update stock_transfer_lines set shipped_base=${sum("dispatched_base")},received_good_base=${good},received_damaged_base=${damaged},received_hold_base=${hold},received_base=${good + damaged + hold},rejected_base=${damaged},short_base=${sum("short_base") - sum("resolved_short_base")},over_base=${sum("over_base") - sum("resolved_over_base")} where id=${l.id}`;
  }
}

// ---------------------------------------------------------------- request / submit

/**
 * Create the document. Plain words in errors: this is what a clerk reads.
 * @param {Ctx} c @param {any} b
 */
export async function createTransfer(c, b) {
  const type = choice(b.type, [...TRANSFER_TYPES], "depot_transfer");
  const source = await loadLocation(c, b.sourceLocationId, "inventory.write");
  const dest = await loadLocation(
    c,
    b.destinationLocationId,
    "inventory.write",
  );
  if (source.id === dest.id) invalid("From and to must be different places");
  const depotSide = ["van_load_in", "return_to_depot"].includes(type)
    ? dest
    : source;
  const transit = b.inTransitLocationId
    ? await loadLocation(c, b.inTransitLocationId, "inventory.write")
    : await transitLocationFor(c.db, depotSide);
  if (transit.type !== "in_transit") invalid("Choose an in-transit location");
  if (new Set([source.id, dest.id, transit.id]).size !== 3)
    invalid("Source, destination and transit locations must differ");
  if (!source.active || !dest.active) invalid("Choose active locations");
  if (
    ["depot_transfer", "store_replenishment"].includes(type) &&
    (!source.allows_picking || !dest.allows_receiving)
  )
    invalid("Source must allow picking and destination must allow receiving");
  const input = Array.isArray(b.lines) ? b.lines : [];
  if (!input.length || input.length > 200) invalid("Supply 1–200 lines");
  const number = await nextDocNumber(c.db, ORGANIZATION, {
    type: DOC_TYPE[type] ?? "TRF",
    locationCode: docLocation(source.code),
    at: c.now,
  });
  const transferId = crypto.randomUUID();
  const status = b.draft === true ? "draft" : "requested";
  await c.db`insert into stock_transfers (id,organization_id,transfer_number,type,source_location_id,destination_location_id,in_transit_location_id,status,requested_by,note,driver_name,vehicle_plate,receiver_name,source_ref)
    values (${transferId},${ORGANIZATION},${number},${type},${source.id},${dest.id},${transit.id},${status},${(c.trusted ? b.requestedBy : null) ?? c.actor.userId},${b.note ?? null},${optionalText(b.driverName, "Driver")},${optionalText(b.vehiclePlate, "Vehicle plate")},${optionalText(b.receiverName, "Receiver")},${b.sourceRef ?? null})`;
  const seen = new Set();
  for (const l of input) {
    await productPolicy(c.db, id(l.productId));
    const stockStatus = choice(
      l.stockStatus,
      [
        "available",
        "quality_hold",
        "quarantine",
        "damaged",
        "expired",
        "rejected",
      ],
      "available",
    );
    const key = `${l.productId}:${stockStatus}`;
    if (seen.has(key)) invalid("Use one transfer line per product");
    seen.add(key);
    integer(l.quantityBase, "Transfer quantity", 1);
    await c.db`insert into stock_transfer_lines (organization_id,transfer_id,product_id,requested_base,approved_base,shipped_base,received_base,rejected_base,short_base,stock_status)
      values (${ORGANIZATION},${transferId},${l.productId},${l.quantityBase},0,0,0,0,0,${stockStatus})`;
  }
  return { id: transferId, number, status: presentStatus(status), type };
}

// ---------------------------------------------------------------- approve (reserves)

/** Approving reserves the stock, so a later dispatch cannot fail for lack of it.
 * @param {Ctx} c @param {any} b @param {any} row */
export async function approveTransfer(c, b, row) {
  state(row, ["requested"]);
  notSelf(c.actor, row.requested_by);
  const lines = await linesOf(c.db, row.id);
  const override = new Map(
    (Array.isArray(b.lines) ? b.lines : []).map((/** @type {any} */ l) => [
      l.lineId,
      l,
    ]),
  );
  for (const k of override.keys())
    if (!lines.some((/** @type {any} */ l) => l.id === k))
      invalid("That line is not on this document");
  /** @type {Array<{line:any, qty:number}>} */ const approved = [];
  for (const l of lines) {
    const o = /** @type {any} */ (override.get(l.id));
    const qty =
      o?.approvedBase == null
        ? Number(l.requested_base)
        : integer(o.approvedBase, "Approved quantity", 0);
    if (qty > Number(l.requested_base))
      invalid("You cannot approve more than was asked for");
    approved.push({ line: l, qty });
  }
  if (!approved.some((a) => a.qty > 0)) invalid("Approve at least one line");
  /** @type {MovementLine[]} */ const reserve = [];
  /** @type {any[]} */ const reserveFor = [];
  for (const a of approved) {
    await c.db`update stock_transfer_lines set approved_base=${a.qty} where id=${a.line.id}`;
    if (a.qty > 0 && a.line.stock_status === "available") {
      reserve.push({
        productId: a.line.product_id,
        fromLocationId: row.source_location_id,
        toLocationId: null,
        quantityBase: a.qty,
        uom: "base",
        fromStockStatus: "available",
      });
      reserveFor.push(a);
    }
  }
  let reserveMovementId = null;
  if (reserve.length) {
    // A real reservation row, so a recall or the expiry job releases it like any other reservation.
    const reservationId = crypto.randomUUID();
    await c.db`insert into inventory_reservations (id,organization_id,reservation_number,reservation_type,source_type,source_document_id,status,created_by)
      values (${reservationId},${ORGANIZATION},${`RS-${reservationId.slice(0, 8).toUpperCase()}`},'transfer','stock_transfer',${row.id},'active',${c.actor.userId})`;
    const m = await move(
      c,
      b,
      "reserve",
      "reservation",
      "stock_transfer",
      row.id,
      reserve,
      [row.source_location_id],
    );
    reserveMovementId = m.movementId;
    const got =
      await c.db`select ml.line_number,a.lot_id,a.quantity_base from inventory_movement_lines ml left join inventory_allocations a on a.movement_line_id=ml.id where ml.movement_id=${m.movementId} order by ml.line_number,a.allocation_sequence`;
    for (const [i, a] of reserveFor.entries()) {
      const parts = got.filter(
        (/** @type {any} */ g) =>
          Number(g.line_number) === i + 1 && g.quantity_base != null,
      );
      const { scale } = await productPolicy(c.db, a.line.product_id);
      for (const p of parts.length
        ? parts
        : [{ lot_id: null, quantity_base: a.qty }]) {
        await upsertAllocation(c.db, {
          transferId: row.id,
          lineId: a.line.id,
          productId: a.line.product_id,
          lotId: p.lot_id,
          reserved: Number(p.quantity_base),
          scale,
        });
        await c.db`insert into inventory_reservation_lines (organization_id,reservation_id,product_id,location_id,lot_id,requested_base,reserved_base,consumed_base,released_base)
          values (${ORGANIZATION},${reservationId},${a.line.product_id},${row.source_location_id},${p.lot_id},${p.quantity_base},${p.quantity_base},0,0)`;
      }
    }
  }
  await c.db`update stock_transfers set status='approved',approved_by=${c.actor.userId},approved_at=now(),reserve_movement_id=${reserveMovementId} where id=${row.id}`;
  return { id: row.id, status: "approved", reserved: reserve.length > 0 };
}

/** @param {any} db @param {{transferId:string,lineId:string,productId:string,lotId:string|null,reserved?:number,dispatched?:number,cost?:number,scale:number,shortLocationId?:string}} a */
async function upsertAllocation(db, a) {
  await db`insert into stock_transfer_allocations (organization_id,transfer_id,transfer_line_id,product_id,lot_id,reserved_base,dispatched_base,unit_cost_minor,quantity_scale,short_location_id)
    values (${ORGANIZATION},${a.transferId},${a.lineId},${a.productId},${a.lotId},${a.reserved ?? 0},${a.dispatched ?? 0},${a.cost ?? 0},${a.scale},${a.shortLocationId ?? null})
    on conflict (transfer_line_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set
      reserved_base=stock_transfer_allocations.reserved_base+excluded.reserved_base,
      dispatched_base=stock_transfer_allocations.dispatched_base+excluded.dispatched_base,
      unit_cost_minor=case when excluded.dispatched_base>0 then excluded.unit_cost_minor else stock_transfer_allocations.unit_cost_minor end,
      short_location_id=coalesce(excluded.short_location_id,stock_transfer_allocations.short_location_id)`;
}

// ---------------------------------------------------------------- pick

/** @param {Ctx} c @param {any} b @param {any} row */
export async function pickTransfer(c, b, row) {
  state(row, ["approved", "picking"]);
  const lines = await linesOf(c.db, row.id);
  const override = new Map(
    (Array.isArray(b.lines) ? b.lines : []).map((/** @type {any} */ l) => [
      l.lineId,
      l,
    ]),
  );
  for (const k of override.keys())
    if (!lines.some((/** @type {any} */ l) => l.id === k))
      invalid("That line is not on this document");
  for (const l of lines) {
    const o = /** @type {any} */ (override.get(l.id));
    const qty =
      o?.pickedBase != null
        ? integer(o.pickedBase, "Picked quantity", 0)
        : row.status === "approved"
          ? Number(l.approved_base)
          : Number(l.picked_base);
    if (qty > Number(l.approved_base))
      invalid("You cannot pick more than was approved");
    await c.db`update stock_transfer_lines set picked_base=${qty} where id=${l.id}`;
  }
  await c.db`update stock_transfers set status='picking',picked_by=${c.actor.userId},picked_at=now() where id=${row.id}`;
  return { id: row.id, status: "picking" };
}

/** Release whatever is still reserved for this document. Returns what was live, by "productId:lotId".
 * @param {Ctx} c @param {any} b @param {any} row @returns {Promise<Map<string,number>>} */
async function releaseReservation(c, b, row) {
  /** @type {Map<string,number>} */ const live = new Map();
  const [res] =
    await c.db`select * from inventory_reservations where organization_id=${ORGANIZATION} and source_type='stock_transfer' and source_document_id=${row.id} and status in ('active','partially_consumed') for update`;
  if (!res) return live;
  const rows =
    await c.db`select * from inventory_reservation_lines where reservation_id=${res.id} order by created_at,id`;
  /** @type {MovementLine[]} */ const out = [];
  for (const l of rows) {
    const left =
      Number(l.reserved_base) -
      Number(l.consumed_base) -
      Number(l.released_base);
    if (left <= 0) continue;
    live.set(
      `${l.product_id}:${l.lot_id ?? ""}`,
      (live.get(`${l.product_id}:${l.lot_id ?? ""}`) ?? 0) + left,
    );
    out.push({
      productId: l.product_id,
      fromLocationId: l.location_id,
      toLocationId: null,
      quantityBase: left,
      uom: "base",
      fromStockStatus: "available",
      ...(l.lot_id ? { lotId: l.lot_id } : {}),
    });
  }
  if (out.length)
    await move(
      c,
      b,
      "release",
      "reservation_release",
      "stock_transfer",
      row.id,
      out,
      [row.source_location_id, row.in_transit_location_id],
    );
  await c.db`update inventory_reservation_lines set released_base=reserved_base-consumed_base where reservation_id=${res.id}`;
  await c.db`update inventory_reservations set status='released' where id=${res.id}`;
  return live;
}

// ---------------------------------------------------------------- dispatch

/** Available -> In transit. Reservation is released first so the same batches ship (earliest expiry first, frozen at approval).
 * @param {Ctx} c @param {any} b @param {any} row */
export async function dispatchTransfer(c, b, row) {
  state(row, ["approved", "picking"]);
  const lines = await linesOf(c.db, row.id);
  const allocs = await allocationsOf(c.db, row.id);
  // What is still reserved (a recall or expiry may already have released a batch). Released here, then shipped.
  const live = await releaseReservation(c, b, row);
  /** @type {MovementLine[]} */ const ship = [];
  /** @type {Array<{line:any, alloc:any|null, qty:number}>} */ const plan = [];
  for (const l of lines) {
    const qty =
      row.status === "picking"
        ? Number(l.picked_base)
        : Number(l.approved_base);
    if (qty <= 0) continue;
    let left = qty;
    if (l.stock_status === "available") {
      for (const a of allocs.filter(
        (/** @type {any} */ x) => x.transfer_line_id === l.id,
      )) {
        const key = `${a.product_id}:${a.lot_id ?? ""}`;
        const take = Math.min(left, live.get(key) ?? 0);
        if (take <= 0) continue;
        live.set(key, (live.get(key) ?? 0) - take);
        plan.push({ line: l, alloc: a, qty: take });
        left -= take;
      }
    }
    if (left > 0) plan.push({ line: l, alloc: null, qty: left }); // earliest expiry first, from what is free now
  }
  if (!plan.length) invalid("Nothing was picked to send");
  const authorized = [row.source_location_id, row.in_transit_location_id];
  for (const p of plan)
    ship.push({
      productId: p.line.product_id,
      fromLocationId: row.source_location_id,
      toLocationId: row.in_transit_location_id,
      quantityBase: p.qty,
      uom: "base",
      fromStockStatus: p.line.stock_status,
      toStockStatus: "in_transit",
      ...(p.alloc?.lot_id ? { lotId: p.alloc.lot_id } : {}),
    });
  const movement = await move(
    c,
    b,
    "ship",
    "transfer_ship",
    "stock_transfer",
    row.id,
    ship,
    authorized,
  );
  const got =
    await c.db`select ml.line_number,ml.unit_cost_minor,a.lot_id,a.quantity_base from inventory_movement_lines ml left join inventory_allocations a on a.movement_line_id=ml.id where ml.movement_id=${movement.movementId} order by ml.line_number,a.allocation_sequence`;
  for (const [i, p] of plan.entries()) {
    const all = got.filter(
      (/** @type {any} */ g) => Number(g.line_number) === i + 1,
    );
    const parts = all.filter((/** @type {any} */ g) => g.quantity_base != null);
    const cost = Number(all[0]?.unit_cost_minor ?? 0);
    const { scale } = await productPolicy(c.db, p.line.product_id);
    for (const part of parts.length
      ? parts
      : [{ lot_id: null, quantity_base: p.qty }])
      await upsertAllocation(c.db, {
        transferId: row.id,
        lineId: p.line.id,
        productId: p.line.product_id,
        lotId: part.lot_id,
        dispatched: Number(part.quantity_base),
        cost,
        scale,
        shortLocationId: row.in_transit_location_id,
      });
  }
  await refreshLines(c, row.id);
  await c.db`update stock_transfers set status='shipped',shipped_by=${c.actor.userId},dispatched_at=now(),outbound_movement_id=${movement.movementId},driver_name=coalesce(${optionalText(b.driverName, "Driver")},driver_name),vehicle_plate=coalesce(${optionalText(b.vehiclePlate, "Vehicle plate")},vehicle_plate),receiver_name=coalesce(${optionalText(b.receiverName, "Receiver")},receiver_name) where id=${row.id}`;
  return { id: row.id, status: "dispatched", movementId: movement.movementId };
}

// ---------------------------------------------------------------- receive

/** Documents dispatched before batches were tracked per allocation: rebuild them from the outbound movement.
 * @param {Ctx} c @param {any} row @param {any[]} lines */
async function backfillAllocations(c, row, lines) {
  if (!row.outbound_movement_id) return;
  const got =
    await c.db`select ml.product_id,ml.unit_cost_minor,ml.quantity_base,a.lot_id,a.quantity_base as alloc_qty from inventory_movement_lines ml left join inventory_allocations a on a.movement_line_id=ml.id where ml.movement_id=${row.outbound_movement_id} and ml.to_location_id=${row.in_transit_location_id} order by ml.line_number,a.allocation_sequence`;
  for (const g of got) {
    const line = lines.find(
      (/** @type {any} */ l) => l.product_id === g.product_id,
    );
    if (!line) continue;
    const { scale } = await productPolicy(c.db, g.product_id);
    await upsertAllocation(c.db, {
      transferId: row.id,
      lineId: line.id,
      productId: g.product_id,
      lotId: g.lot_id ?? null,
      dispatched: Number(g.alloc_qty ?? g.quantity_base),
      cost: Number(g.unit_cost_minor ?? 0),
      scale,
      shortLocationId: row.in_transit_location_id,
    });
  }
  await refreshLines(c, row.id);
}

/**
 * Receive posts In transit -> Available (good) / Damaged (damaged) / On hold (recalled or held batches, never refused).
 * Repeatable. Counted stock beyond what was sent is recorded as "over" and is not in the ledger until someone resolves it.
 * @param {Ctx} c @param {any} b @param {any} row
 * @param {{authorized?:string[]}} [opts]
 */
export async function receiveTransfer(c, b, row, opts = {}) {
  state(row, ["shipped", "partially_received", ...OPEN_VARIANCE_STATES]);
  const lines = await linesOf(c.db, row.id);
  let allocs = await allocationsOf(c.db, row.id);
  if (!allocs.length) {
    await backfillAllocations(c, row, lines);
    allocs = await allocationsOf(c.db, row.id);
  }
  /** @type {Map<string,{good:number,damaged:number,hold:number,reason:string|null,note:string|null,photos:number}>} */
  const want = new Map();
  const add = (/** @type {string} */ key, /** @type {any} */ v) => {
    const o = want.get(key) ?? {
      good: 0,
      damaged: 0,
      hold: 0,
      reason: null,
      note: null,
      photos: 0,
    };
    o.good += v.good;
    o.damaged += v.damaged;
    o.hold += v.hold;
    o.reason = v.reason ?? o.reason;
    o.note = v.note ?? o.note;
    o.photos += v.photos ?? 0;
    want.set(key, o);
  };
  if (!Array.isArray(b.lines)) {
    for (const a of allocs) {
      const remaining = Number(a.dispatched_base) - posted(a);
      if (remaining > 0)
        add(a.id, {
          good: remaining,
          damaged: 0,
          hold: 0,
          reason: null,
          note: null,
          photos: 0,
        });
    }
  } else {
    if (b.lines.length > 300) invalid("Too many lines in one receipt");
    for (const l of b.lines) {
      const line = lines.find((/** @type {any} */ x) => x.id === l.lineId);
      if (!line) invalid("That line is not on this document");
      const good = integer(
          l.receivedGoodBase ?? l.receivedGood ?? 0,
          "Good quantity",
          0,
        ),
        damaged = integer(
          l.receivedDamagedBase ?? l.receivedDamaged ?? 0,
          "Damaged quantity",
          0,
        ),
        hold = integer(
          l.receivedHoldBase ?? l.receivedHold ?? 0,
          "On-hold quantity",
          0,
        );
      if (!good && !damaged && !hold) continue;
      const mine = allocs.filter(
        (/** @type {any} */ a) => a.transfer_line_id === line.id,
      );
      let target = l.batchId
        ? mine.find((/** @type {any} */ a) => a.lot_id === l.batchId)
        : null;
      if (!target && !l.batchId && mine.length === 1) target = mine[0];
      if (!target && !l.batchId && mine.length > 1)
        invalid("Choose the batch for this line");
      if (!target) {
        // A batch that was not sent: it can only arrive as "over".
        if (l.batchId) {
          const [lot] =
            await c.db`select id from inventory_lots where id=${id(l.batchId)} and product_id=${line.product_id} and organization_id=${ORGANIZATION}`;
          if (!lot) invalid("That batch does not belong to this product");
        } else if (
          (await productPolicy(c.db, line.product_id)).tracking === "lot"
        )
          invalid("Choose the batch for this line");
        const { scale } = await productPolicy(c.db, line.product_id);
        await upsertAllocation(c.db, {
          transferId: row.id,
          lineId: line.id,
          productId: line.product_id,
          lotId: l.batchId ?? null,
          scale,
          shortLocationId: row.in_transit_location_id,
        });
        allocs = await allocationsOf(c.db, row.id);
        target = allocs.find(
          (/** @type {any} */ a) =>
            a.transfer_line_id === line.id &&
            (a.lot_id ?? null) === (l.batchId ?? null),
        );
      }
      let reason = null;
      if (damaged > 0) {
        if (!l.reasonCode) invalid("Choose a reason for the damaged items");
        const r = await requireReason(c.db, ORGANIZATION, l.reasonCode, {
          direction: "out",
          note: l.note,
          photoCount: Number(
            l.photoCount ?? (Array.isArray(l.photos) ? l.photos.length : 0),
          ),
        });
        reason = r.code;
      }
      add(target.id, {
        good,
        damaged,
        hold,
        reason,
        note: l.note ?? null,
        photos: 0,
      });
    }
  }
  if (!want.size && b.final !== true)
    invalid("Enter what arrived on at least one line");
  /** @type {MovementLine[]} */ const posting = [];
  for (const [allocId, w] of want) {
    const a = allocs.find((/** @type {any} */ x) => x.id === allocId);
    let remaining = Number(a.dispatched_base) - posted(a);
    const dmg = Math.min(w.damaged, remaining);
    remaining -= dmg;
    const hold = Math.min(w.hold, remaining);
    remaining -= hold;
    const good = Math.min(w.good, remaining);
    const over = w.good - good + (w.hold - hold) + (w.damaged - dmg);
    const toHold = heldLot(a);
    const base = {
      productId: a.product_id,
      fromLocationId: row.in_transit_location_id,
      toLocationId: row.destination_location_id,
      uom: "base",
      fromStockStatus: "in_transit",
      unitCostMinor: Number(a.unit_cost_minor),
      ...(a.lot_id ? { lotId: a.lot_id } : {}),
    };
    if (good)
      posting.push({
        ...base,
        quantityBase: good,
        toStockStatus: toHold ? "quality_hold" : "available",
      });
    if (hold)
      posting.push({
        ...base,
        quantityBase: hold,
        toStockStatus: "quality_hold",
      });
    if (dmg)
      posting.push({ ...base, quantityBase: dmg, toStockStatus: "damaged" });
    await c.db`update stock_transfer_allocations set
      received_good_base=received_good_base+${toHold ? 0 : good},
      received_hold_base=received_hold_base+${hold + (toHold ? good : 0)},
      received_damaged_base=received_damaged_base+${dmg},
      over_base=over_base+${over},
      damage_reason_code=coalesce(${w.reason},damage_reason_code) where id=${a.id}`;
    if (w.reason)
      await c.db`update stock_transfer_lines set reason_code=${w.reason},note=coalesce(${w.note},note) where id=${a.transfer_line_id}`;
  }
  let movementId = null;
  if (posting.length) {
    const m = await move(
      c,
      b,
      "recv",
      "transfer_receive",
      "stock_transfer",
      row.id,
      posting,
      opts.authorized ?? [
        row.in_transit_location_id,
        row.destination_location_id,
      ],
    );
    movementId = m.movementId;
  }
  await c.db`update stock_transfers set received_by=${c.actor.userId},first_received_at=coalesce(first_received_at,now()),receipt_movement_id=coalesce(${movementId},receipt_movement_id) where id=${row.id}`;
  await refreshLines(c, row.id);
  return settle(c, b, row, { final: b.final === true, movementId });
}

/** Decide where the document stands after a receipt: partial, received, closed by tolerance, or needing a decision.
 * @param {Ctx} c @param {any} b @param {any} row @param {{final:boolean, movementId?:string|null}} o */
async function settle(c, b, row, o) {
  const allocs = await allocationsOf(c.db, row.id);
  const dispatchedAny = allocs.some(
    (/** @type {any} */ a) => Number(a.dispatched_base) > 0,
  );
  const complete = allocs
    .filter((/** @type {any} */ a) => Number(a.dispatched_base) > 0)
    .every((/** @type {any} */ a) => posted(a) >= Number(a.dispatched_base));
  const final = o.final || (dispatchedAny && complete);
  const anyPosted = allocs.some((/** @type {any} */ a) => posted(a) > 0);
  if (!final) {
    await c.db`update stock_transfers set status=${anyPosted ? "partially_received" : row.status} where id=${row.id}`;
    return {
      id: row.id,
      status: anyPosted ? "partially_received" : presentStatus(row.status),
      movementId: o.movementId ?? null,
      varianceStatus: row.variance_status,
    };
  }
  let value = 0n,
    hasVariance = false;
  for (const a of allocs) {
    const short = Math.max(0, Number(a.dispatched_base) - posted(a));
    await c.db`update stock_transfer_allocations set short_base=${short} where id=${a.id}`;
    const touched =
      short +
      Number(a.over_base) +
      (row.type === "van_load_in" ? 0 : Number(a.received_damaged_base));
    if (touched > 0) hasVariance = true;
    value += valueOf(a.unit_cost_minor, touched, a.quantity_scale);
  }
  await refreshLines(c, row.id);
  await c.db`update stock_transfers set final_receipt=true,received_at=now(),variance_value_centavos=${value.toString()} where id=${row.id}`;
  if (!hasVariance) {
    await c.db`update stock_transfers set status='received',variance_status='none' where id=${row.id}`;
    return {
      id: row.id,
      status: "received",
      movementId: o.movementId ?? null,
      varianceStatus: "none",
      varianceValueCentavos: 0,
    };
  }
  const tol = await toleranceFor(
    c.db,
    ORGANIZATION,
    toleranceEvent(row.type),
    c.now,
  );
  if (withinTolerance(tol, { centavos: Number(value) })) {
    await resolveStock(c, b, row, {
      auto: true,
      chargeTo: "none",
      shortReason: "SHORT-TRANSIT",
      overReason: "FOUND",
      note: "Inside the allowed difference, accepted automatically",
      decidedBy: c.actor.userId,
    });
    return {
      id: row.id,
      status: "closed",
      movementId: o.movementId ?? null,
      varianceStatus: "auto_accepted",
      varianceValueCentavos: Number(value),
    };
  }
  await c.db`update stock_transfers set status='review_needed',variance_status='open' where id=${row.id}`;
  return {
    id: row.id,
    status: "review_needed",
    movementId: o.movementId ?? null,
    varianceStatus: "open",
    varianceValueCentavos: Number(value),
  };
}

// ---------------------------------------------------------------- resolve variance

/**
 * One linked adjustment clears what is still short (out of In transit) and adds what is over (into Available, or On hold).
 * @param {Ctx} c @param {any} b @param {any} row
 * @param {{auto?:boolean, chargeTo:string, shortReason?:string, overReason?:string, note?:string|null, decidedBy:string}} r
 */
async function resolveStock(c, b, row, r) {
  const allocs = await allocationsOf(c.db, row.id);
  const postsStock = row.type !== "van_load_in" || !r.auto;
  /** @type {MovementLine[]} */ const lines = [];
  /** @type {any[]} */ const adjustmentLines = [];
  let shortTotal = 0,
    overTotal = 0,
    value = 0n;
  for (const a of allocs) {
    const short = Number(a.short_base) - Number(a.resolved_short_base),
      over = Number(a.over_base) - Number(a.resolved_over_base);
    const cost = Number(a.unit_cost_minor);
    const lot = a.lot_id ? { lotId: a.lot_id } : {};
    if (short > 0) {
      const at = a.short_location_id ?? row.in_transit_location_id;
      const status = a.short_status || "in_transit";
      shortTotal += short;
      value += valueOf(cost, short, a.quantity_scale);
      adjustmentLines.push({
        product: a.product_id,
        lot: a.lot_id,
        location: at,
        status,
        delta: -short,
        cost,
        reason: r.shortReason,
      });
      lines.push({
        productId: a.product_id,
        fromLocationId: at,
        toLocationId: null,
        quantityBase: short,
        uom: "base",
        stockStatus: status,
        unitCostMinor: cost,
        ...lot,
      });
    }
    if (over > 0) {
      overTotal += over;
      value += valueOf(cost, over, a.quantity_scale);
      const status = heldLot(a) ? "quality_hold" : "available";
      adjustmentLines.push({
        product: a.product_id,
        lot: a.lot_id,
        location: row.destination_location_id,
        status,
        delta: over,
        cost,
        reason: r.overReason,
      });
      lines.push({
        productId: a.product_id,
        fromLocationId: null,
        toLocationId: row.destination_location_id,
        quantityBase: over,
        uom: "base",
        stockStatus: status,
        unitCostMinor: cost,
        ...lot,
      });
    }
  }
  let adjustmentId = null;
  if (adjustmentLines.length && postsStock) {
    const [dest] =
      await c.db`select code from inventory_locations where id=${row.destination_location_id}`;
    adjustmentId = crypto.randomUUID();
    const number = await nextDocNumber(c.db, ORGANIZATION, {
      type: "ADJ",
      locationCode: docLocation(dest?.code),
      at: c.now,
    });
    await c.db`insert into inventory_adjustments (id,organization_id,adjustment_number,adjustment_type,reason_code,status,requested_by,approved_by,note,source_transfer_id)
      values (${adjustmentId},${ORGANIZATION},${number},'transfer_variance',${r.shortReason ?? r.overReason},'posted',${row.received_by ?? r.decidedBy},${r.decidedBy},${r.note ?? null},${row.id})`;
    for (const l of adjustmentLines)
      await c.db`insert into inventory_adjustment_lines (organization_id,adjustment_id,product_id,lot_id,location_id,stock_status,variance_base,unit_cost_minor,reason_code)
        values (${ORGANIZATION},${adjustmentId},${l.product},${l.lot},${l.location},${l.status},${l.delta},${l.cost},${l.reason})`;
    const m = await move(
      c,
      b,
      "resolve",
      "inventory_adjustment",
      "inventory_adjustment",
      adjustmentId,
      lines,
      [
        row.in_transit_location_id,
        row.destination_location_id,
        ...new Set(adjustmentLines.map((l) => l.location)),
      ],
    );
    await c.db`update inventory_adjustments set movement_id=${m.movementId} where id=${adjustmentId}`;
  }
  await c.db`update stock_transfer_allocations set resolved_short_base=short_base,resolved_over_base=over_base where transfer_id=${row.id}`;
  await c.db`insert into stock_transfer_resolutions (organization_id,transfer_id,adjustment_id,decided_by,auto,charge_to,short_reason_code,over_reason_code,short_base,over_base,value_centavos,note)
    values (${ORGANIZATION},${row.id},${adjustmentId},${r.decidedBy},${r.auto === true},${r.auto ? "tolerance" : r.chargeTo},${shortTotal ? (r.shortReason ?? null) : null},${overTotal ? (r.overReason ?? null) : null},${shortTotal},${overTotal},${value.toString()},${r.note ?? null})`;
  await refreshLines(c, row.id);
  await c.db`update stock_transfers set status='closed',variance_status=${r.auto ? "auto_accepted" : "resolved"},closed_by=${r.decidedBy},closed_at=now() where id=${row.id}`;
  return {
    id: row.id,
    status: "closed",
    adjustmentId,
    shortBase: shortTotal,
    overBase: overTotal,
    valueCentavos: Number(value),
  };
}

/** Someone with authority who is neither the sender nor the receiver decides who carries the difference.
 * @param {Ctx} c @param {any} b @param {any} row */
export async function resolveVariance(c, b, row) {
  state(row, OPEN_VARIANCE_STATES);
  for (const who of [row.received_by, row.shipped_by])
    if (who && (who === c.actor.userId || who === c.actor.profileId))
      throw new ApiError(
        "self_approval",
        403,
        "A different person must decide this difference: the sender and the receiver cannot",
      );
  const allocs = await allocationsOf(c.db, row.id);
  const openShort = allocs.reduce(
    (/** @type {number} */ n, /** @type {any} */ a) =>
      n + Number(a.short_base) - Number(a.resolved_short_base),
    0,
  );
  const openOver = allocs.reduce(
    (/** @type {number} */ n, /** @type {any} */ a) =>
      n + Number(a.over_base) - Number(a.resolved_over_base),
    0,
  );
  const chargeTo = choice(
    b.chargeTo,
    CHARGE_TO,
    openShort || openOver ? undefined : "none",
  );
  if ((openShort || openOver) && chargeTo === "none")
    invalid(
      "Say who carries the difference: sending side, receiving side, carrier or driver",
    );
  const note = b.note == null ? null : text(b.note, "Note", 500);
  let shortReason, overReason;
  if (openShort > 0)
    shortReason = (
      await requireReason(
        c.db,
        ORGANIZATION,
        b.shortReasonCode ?? b.reasonCode,
        { direction: "out", note },
      )
    ).code;
  if (openOver > 0)
    overReason = (
      await requireReason(
        c.db,
        ORGANIZATION,
        b.overReasonCode ?? b.reasonCode,
        { direction: "in", note },
      )
    ).code;
  return resolveStock(c, b, row, {
    chargeTo,
    shortReason,
    overReason,
    note,
    decidedBy: c.actor.userId,
  });
}

// ---------------------------------------------------------------- van load-in

/**
 * A truck coming back is a movement document too (type van load-in): the seller's count against what the clerk received.
 * The truck-to-depot stock already moved (route-evidence posts it); this records good / on hold / short / over so a
 * difference is visible, can go to a supervisor when it is bigger than the allowed difference, and over (counted but
 * never on the truck's books) is added only once someone resolves it. Short stays on the truck until resolved.
 * @param {Ctx} c
 * @param {{trip:any, sellerUserId?:string|null, movementId?:string|null, source?:string,
 *   lines:Array<{productId:string, lotId:string|null, status:string, expectedBase:number, receivedBase:number, toStatus:string}>}} d
 */
export async function recordLoadInDocument(c, d) {
  const { trip } = d;
  const [truck] =
    await c.db`select * from inventory_locations where id=${trip.truck_location_id}`;
  const [depot] =
    await c.db`select * from inventory_locations where id=${trip.source_location_id}`;
  const transit = await transitLocationFor(c.db, depot);
  const number = await nextDocNumber(c.db, ORGANIZATION, {
    type: "LIN",
    locationCode: docLocation(depot.code),
    at: c.now,
  });
  const [vehicle] =
    await c.db`select plate_number from vehicles where id=${trip.vehicle_id}`;
  const transferId = crypto.randomUUID();
  await c.db`insert into stock_transfers (id,organization_id,transfer_number,type,source_location_id,destination_location_id,in_transit_location_id,status,requested_by,shipped_by,received_by,driver_name,vehicle_plate,source_ref,outbound_movement_id,receipt_movement_id,dispatched_at,first_received_at,final_receipt)
    values (${transferId},${ORGANIZATION},${number},'van_load_in',${truck.id},${depot.id},${transit.id},'received',${d.sellerUserId ?? c.actor.userId},${d.sellerUserId ?? null},${c.actor.userId},${trip.driver_name ?? null},${vehicle?.plate_number ?? null},${d.source ?? null},${d.movementId ?? null},${d.movementId ?? null},now(),now(),true)`;
  /** @type {Map<string,string>} */ const lineIds = new Map();
  for (const l of d.lines) {
    const key = `${l.productId}:${l.status}`;
    if (!lineIds.has(key)) {
      const total = d.lines
        .filter((x) => x.productId === l.productId && x.status === l.status)
        .reduce((n, x) => n + x.expectedBase, 0);
      const [row] =
        await c.db`insert into stock_transfer_lines (organization_id,transfer_id,product_id,requested_base,approved_base,picked_base,shipped_base,received_base,rejected_base,short_base,stock_status)
        values (${ORGANIZATION},${transferId},${l.productId},${total},${total},${total},${total},0,0,0,${["available", "damaged"].includes(l.status) ? l.status : "available"}) returning id`;
      lineIds.set(key, row.id);
    }
    const { scale } = await productPolicy(c.db, l.productId);
    const [bal] =
      await c.db`select weighted_average_cost_minor from inventory_balances where organization_id=${ORGANIZATION} and product_id=${l.productId} and location_id=${truck.id}`;
    const posted = Math.min(l.receivedBase, l.expectedBase);
    const over = Math.max(0, l.receivedBase - l.expectedBase);
    const isDamaged = l.status === "damaged";
    await c.db`insert into stock_transfer_allocations (organization_id,transfer_id,transfer_line_id,product_id,lot_id,dispatched_base,received_good_base,received_damaged_base,received_hold_base,over_base,unit_cost_minor,quantity_scale,short_location_id,short_status)
      values (${ORGANIZATION},${transferId},${lineIds.get(key)},${l.productId},${l.lotId},${l.expectedBase},${!isDamaged && l.toStatus === "available" ? posted : 0},${isDamaged ? posted : 0},${!isDamaged && l.toStatus !== "available" ? posted : 0},${over},${Number(bal?.weighted_average_cost_minor ?? 0)},${scale},${truck.id},${l.status})
      on conflict (transfer_line_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set
        dispatched_base=stock_transfer_allocations.dispatched_base+excluded.dispatched_base,
        received_good_base=stock_transfer_allocations.received_good_base+excluded.received_good_base,
        received_damaged_base=stock_transfer_allocations.received_damaged_base+excluded.received_damaged_base,
        received_hold_base=stock_transfer_allocations.received_hold_base+excluded.received_hold_base,
        over_base=stock_transfer_allocations.over_base+excluded.over_base`;
  }
  const row = await document(c.db, "stock_transfers", transferId);
  return {
    ...(await settle(c, { idempotencyKey: `load-in:${transferId}` }, row, {
      final: true,
      movementId: d.movementId ?? null,
    })),
    id: transferId,
    number,
  };
}

// ---------------------------------------------------------------- close / cancel

/** @param {Ctx} c @param {any} b @param {any} row */
export async function closeTransfer(c, b, row) {
  state(row, ["received", "partially_received"]);
  if (row.status === "received") {
    await c.db`update stock_transfers set status='closed',closed_by=${c.actor.userId},closed_at=now() where id=${row.id}`;
    return { id: row.id, status: "closed" };
  }
  return receiveTransfer(c, { ...b, lines: [], final: true }, row);
}

/** @param {Ctx} c @param {any} b @param {any} row */
export async function cancelTransfer(c, b, row) {
  state(row, ["draft", "requested", "approved", "picking"]);
  await releaseReservation(c, b, row);
  await c.db`update stock_transfers set status='cancelled',closed_by=${c.actor.userId},closed_at=now() where id=${row.id}`;
  return { id: row.id, status: "cancelled" };
}

// ---------------------------------------------------------------- commands

/** @param {string} name @param {string} cap @param {"all"|"source"|"destination"} gate @param {(c:any,b:any,row:any)=>Promise<any>} fn */
function lifecycle(name, cap, gate, fn) {
  commands[`transfers/${name}`] = {
    cap,
    prepare: async (c, b) => {
      const row = await document(c.db, "stock_transfers", id(b.transferId));
      if (gate === "all") await gateTransfer(c.db, row, cap, c.actor);
      else
        await locationGate(
          c,
          cap,
          gate === "source"
            ? row.source_location_id
            : row.destination_location_id,
          row.organization_id,
        );
      return row;
    },
    run: async (c, b, row) => fn(c, b, row),
  };
}

export function installTransferCommands() {
  commands["transfers/request"] = {
    cap: "inventory.write",
    prepare: async (c, b) => {
      for (const k of ["sourceLocationId", "destinationLocationId"])
        await locationGate(c, "inventory.write", id(b[k]));
      if (b.inTransitLocationId)
        await locationGate(c, "inventory.write", id(b.inTransitLocationId));
      return null;
    },
    run: async (c, b) => createTransfer(c, b),
  };
  lifecycle("submit", "inventory.write", "source", async (c, _b, row) => {
    state(row, ["draft"]);
    await c.db`update stock_transfers set status='requested' where id=${row.id}`;
    return { id: row.id, status: "requested" };
  });
  lifecycle("approve", "inventory.approve", "all", approveTransfer);
  lifecycle("pick", "inventory.write", "source", pickTransfer);
  lifecycle("dispatch", "inventory.write", "source", dispatchTransfer);
  lifecycle("ship", "inventory.write", "source", dispatchTransfer); // v1 name
  lifecycle("receive", "inventory.write", "destination", receiveTransfer);
  lifecycle("close", "inventory.write", "destination", closeTransfer);
  lifecycle("resolve-variance", "inventory.approve", "all", resolveVariance);
  lifecycle("cancel", "inventory.approve", "all", cancelTransfer);
}

// ---------------------------------------------------------------- reads

/** @param {any} db @param {string[]} userIds */
async function namesFor(db, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows =
    await db`select user_id,name from profiles where user_id in ${db(ids)}`;
  return new Map(rows.map((/** @type {any} */ r) => [r.user_id, r.name]));
}
/** @param {any} db @param {any} row @param {boolean} [full] */
export async function presentTransfer(db, row, full = true) {
  const places =
    await db`select id,code,name,type from inventory_locations where id in ${db([row.source_location_id, row.destination_location_id, row.in_transit_location_id])}`;
  const place = (/** @type {string} */ k) => {
    const p = places.find((/** @type {any} */ x) => x.id === k);
    return p ? { id: p.id, code: p.code, name: p.name, type: p.type } : null;
  };
  const names = await namesFor(db, [
    row.requested_by,
    row.approved_by,
    row.picked_by,
    row.shipped_by,
    row.received_by,
    row.closed_by,
  ]);
  const who = (/** @type {string|null} */ k) =>
    k ? { id: k, name: names.get(k) ?? null } : null;
  const lineRows =
    await db`select l.*,p.code as product_code,p.name as product_name,p.organization_id as organization_id_p from stock_transfer_lines l join products p on p.id=l.product_id where l.transfer_id=${row.id} order by l.seq`;
  const allocs = full ? await allocationsOf(db, row.id) : [];
  const caseSizes = new Map();
  if (full)
    for (const l of lineRows) {
      if (caseSizes.has(l.product_id)) continue;
      try {
        const { product } = await productPolicy(db, l.product_id);
        const u = await unitInfo(db, product, Date.now());
        caseSizes.set(l.product_id, u.basePerCase ?? null);
      } catch {
        caseSizes.set(l.product_id, null);
      }
    }
  const out = {
    id: row.id,
    number: row.transfer_number,
    type: row.type,
    typeLabel: TRANSFER_TYPE_LABELS[row.type] ?? row.type,
    status: presentStatus(row.status),
    storedStatus: row.status,
    source: place(row.source_location_id),
    destination: place(row.destination_location_id),
    inTransit: place(row.in_transit_location_id),
    header: {
      driverName: row.driver_name,
      vehiclePlate: row.vehicle_plate,
      receiverName: row.receiver_name,
      note: row.note,
      sourceRef: row.source_ref,
    },
    people: {
      requestedBy: who(row.requested_by),
      approvedBy: who(row.approved_by),
      pickedBy: who(row.picked_by),
      dispatchedBy: who(row.shipped_by),
      receivedBy: who(row.received_by),
      closedBy: who(row.closed_by),
    },
    dates: {
      created: row.created_at,
      approved: row.approved_at,
      picked: row.picked_at,
      dispatched: row.dispatched_at,
      firstReceived: row.first_received_at,
      received: row.received_at,
      closed: row.closed_at,
    },
    varianceStatus: row.variance_status,
    varianceValueCentavos: Number(row.variance_value_centavos ?? 0),
    finalReceipt: row.final_receipt,
    movements: {
      reserve: row.reserve_movement_id,
      outbound: row.outbound_movement_id,
      receipt: row.receipt_movement_id,
    },
    lineCount: lineRows.length,
    lines: lineRows.map((/** @type {any} */ l) => ({
      id: l.id,
      productId: l.product_id,
      code: l.product_code,
      name: l.product_name,
      stockStatus: l.stock_status,
      basePerCase: caseSizes.get(l.product_id) ?? null,
      requestedBase: Number(l.requested_base),
      approvedBase: Number(l.approved_base),
      pickedBase: Number(l.picked_base),
      dispatchedBase: Number(l.shipped_base),
      receivedGoodBase: Number(l.received_good_base),
      receivedDamagedBase: Number(l.received_damaged_base),
      receivedHoldBase: Number(l.received_hold_base),
      shortBase: Number(l.short_base),
      overBase: Number(l.over_base),
      reasonCode: l.reason_code,
      allocations: allocs
        .filter((/** @type {any} */ a) => a.transfer_line_id === l.id)
        .map((/** @type {any} */ a) => ({
          id: a.id,
          batchId: a.lot_id,
          batch: a.lot_number ?? null,
          expiresAt: a.expires_at ? new Date(a.expires_at).getTime() : null,
          held: heldLot(a),
          dispatchedBase: Number(a.dispatched_base),
          receivedGoodBase: Number(a.received_good_base),
          receivedDamagedBase: Number(a.received_damaged_base),
          receivedHoldBase: Number(a.received_hold_base),
          remainingBase: Math.max(0, Number(a.dispatched_base) - posted(a)),
          shortBase: Number(a.short_base) - Number(a.resolved_short_base),
          overBase: Number(a.over_base) - Number(a.resolved_over_base),
        })),
    })),
  };
  if (!full) return { ...out, lines: undefined };
  const resolutions =
    await db`select * from stock_transfer_resolutions where transfer_id=${row.id} order by created_at`;
  return {
    ...out,
    resolutions: resolutions.map((/** @type {any} */ r) => ({
      id: r.id,
      adjustmentId: r.adjustment_id,
      auto: r.auto,
      chargeTo: r.charge_to,
      shortReasonCode: r.short_reason_code,
      overReasonCode: r.over_reason_code,
      shortBase: Number(r.short_base),
      overBase: Number(r.over_base),
      valueCentavos: Number(r.value_centavos),
      note: r.note,
      decidedBy: r.decided_by,
      at: r.created_at,
    })),
  };
}

/** A person sees a transfer when they can see its source or its destination. @param {any} ctx */
async function visibleIds(ctx) {
  return new Set((await visibleLocations(ctx)).map((l) => l.id));
}

/** @param {any} ctx */
async function listRoute(ctx) {
  await requireCapability(ctx, "inventory.read");
  const ids = await visibleIds(ctx);
  const q = ctx.url.searchParams;
  const status = q.get("status"),
    type = q.get("type"),
    destination = q.get("destination"),
    source = q.get("source"),
    open = q.get("open") === "1";
  const rows =
    await ctx.db`select * from stock_transfers where organization_id=${ORGANIZATION} order by created_at desc,id desc limit 500`;
  const out = [];
  for (const row of rows) {
    if (
      !ids.has(row.source_location_id) &&
      !ids.has(row.destination_location_id)
    )
      continue;
    if (type && row.type !== type) continue;
    if (destination && row.destination_location_id !== destination) continue;
    if (source && row.source_location_id !== source) continue;
    const shown = presentStatus(row.status);
    if (
      status &&
      ![shown, row.status].includes(
        status === "in_transit" ? "dispatched" : status,
      )
    )
      continue;
    if (open && ["closed", "cancelled", "received"].includes(row.status))
      continue;
    out.push(await presentTransfer(ctx.db, row, false));
  }
  return { transfers: out };
}
/** @param {any} ctx */
async function detailRoute(ctx) {
  await requireCapability(ctx, "inventory.read");
  const ids = await visibleIds(ctx);
  const tid = id(ctx.url.searchParams.get("id"), "Transfer");
  const [row] =
    await ctx.db`select * from stock_transfers where id=${tid} and organization_id=${ORGANIZATION}`;
  if (
    !row ||
    (!ids.has(row.source_location_id) && !ids.has(row.destination_location_id))
  )
    throw new ApiError("not_found", 404, "Transfer not found");
  return presentTransfer(ctx.db, row, true);
}

/** @param {import('../../core/router.js').Router} router */
export function installTransferRoutes(router) {
  router.get("/api/v1/inventory/transfers/list", listRoute);
  router.get("/api/v1/inventory/transfers/detail", detailRoute);
}
