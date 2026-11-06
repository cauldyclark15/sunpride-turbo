import { requireCapability } from "../../core/capabilities.js";
import { ApiError, forbidden } from "../../core/errors.js";
import {
  approveTransfer,
  cancelTransfer,
  closeTransfer,
  createTransfer,
  dispatchTransfer,
  pickTransfer,
  receiveTransfer,
  resolveVariance,
  resolveVarianceByAgreement,
} from "../inventory/transfers.js";
import { toleranceFor, withinTolerance } from "../inventory/tolerances.js";
import { ORGANIZATION } from "../inventory/common.js";
import { audit, explainStock, productFor } from "./facts.js";
import { tripFor, locationFor } from "./access.js";
import { loadedLines, suggestionFromLines } from "./nightly.js";
import { LOAD_REASONS, dayString, refuse, text, uuid } from "./model.js";

/**
 * IP-VANDAY (SPEC 5.2 steps 2-5): a suggested load becomes a VAN LOAD-OUT on the movement document.
 *   suggested -> (edit) -> approved (stock reserved) -> picking -> dispatched (In transit, clerk signs)
 *   -> seller accepts on the phone with short/over per line:
 *        inside the allowed difference ........ accepted, goes onto the truck, no supervisor
 *        above it ............................. the clerk recounts on their own device
 *          clerk and seller agree ............. accepted, both signed, no supervisor
 *          they do not ........................ Decide (the existing load-difference approval)
 * Every stock change is made by the movement document through postMovement; nothing here writes stock.
 */

const PLAN_SYSTEM = "system:van-plan";
const OPEN_STATES = ["suggested", "approved", "picking", "dispatched", "recount", "disputed"];

/** @param {any} v @param {string} [what] */
export function qty(v, what = "Quantity") {
  const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 0)
    refuse(`${what} must be a whole number, zero or more`, "invalid_request");
  return /** @type {number} */ (n);
}
/** @param {any} db @param {any} actor @param {number} [at] @param {boolean} [trusted] */
const ctxFor = (db, actor, at = Date.now(), trusted = true) => ({
  db,
  actor: { userId: actor.userId, profileId: actor.profileId },
  now: at,
  trusted,
});
/** @param {any} db @param {string} tripId @param {boolean} [lock] */
export async function planOf(db, tripId, lock = false) {
  const [plan] = lock
    ? await db`select * from van_planned_loads where trip_id=${tripId} and state<>'cancelled' for update`
    : await db`select * from van_planned_loads where trip_id=${tripId} and state<>'cancelled'`;
  return plan ?? null;
}
/** @param {any} db @param {string} id */
const docRow = async (db, id) => {
  const [r] = await db`select * from stock_transfers where id=${id} for update`;
  if (!r) refuse("The load document is missing");
  return r;
};
/** @param {any} db @param {string} planId */
const planLines = (db, planId) =>
  db`select l.*,p.code,p.name from van_planned_load_lines l join products p on p.id=l.product_id where l.planned_load_id=${planId} order by p.code`;

// ------------------------------------------------------------------ edit / copy before approval

/** POST van/loads/edit {tripId, lines:[{productId, quantityBase}]}: change quantities while still a suggestion. @param {any} db @param {any} actor @param {any} p */
export async function editPlan(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "van.manage", true);
  const plan = await planOf(db, trip.id, true);
  if (!plan) refuse("This trip has no suggested load yet");
  if (plan.state !== "suggested")
    refuse(
      "This load is already approved. Use Change before dispatch to alter it",
    );
  await applyLines(db, plan, trip, p.lines);
  await db`update van_planned_loads set edited_by=${actor.subject},edited_at=now(),updated_at=now() where id=${plan.id}`;
  await audit(db, trip, actor, "van.load.edited", plan.id);
  return { tripId: trip.id, plannedLoadId: plan.id };
}
/** Set approved quantities from `[{productId, quantityBase}]`; a product not in the suggestion is added. @param {any} db @param {any} plan @param {any} trip @param {any} input */
async function applyLines(db, plan, trip, input) {
  if (!Array.isArray(input) || !input.length || input.length > 300)
    refuse("Send 1 to 300 lines", "invalid_request");
  const seen = new Set();
  for (const l of input) {
    const productId = uuid(l.productId);
    if (seen.has(productId)) refuse("Each product appears once", "invalid_request");
    seen.add(productId);
    const q = qty(l.quantityBase);
    const product = await productFor(db, productId);
    const [depot] =
      await db`select available_base::bigint as q from inventory_balances where location_id=${trip.source_location_id} and product_id=${productId} and deleted_at is null`;
    const free = Number(depot?.q ?? 0);
    if (q > free)
      refuse(
        `${product.name}: the depot has ${free} pieces free, not ${q}`,
        "stock_conflict",
      );
    const [row] =
      await db`select id from van_planned_load_lines where planned_load_id=${plan.id} and product_id=${productId}`;
    if (row)
      await db`update van_planned_load_lines set approved_base=${q},edited=true,depot_available_base=${free} where id=${row.id}`;
    else
      await db`insert into van_planned_load_lines(planned_load_id,product_id,case_base,depot_available_base,suggested_base,approved_base,edited,flags) values(${plan.id},${productId},${Number(product.caseBase)},${free},0,${q},true,${db.array(["added"], "TEXT")})`;
  }
}

/** POST van/loads/copy {tripId, fromTripId?}: "Copy yesterday" onto one trip's suggestion. @param {any} db @param {any} actor @param {any} p */
export async function copyYesterday(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "van.manage", true);
  const plan = await planOf(db, trip.id, true);
  if (plan && plan.state !== "suggested")
    refuse("This load is already approved, so it cannot be replaced");
  const [from] = p.fromTripId
    ? await db`select * from van_trips where id=${uuid(p.fromTripId)} and deleted_at is null`
    : await db`select * from van_trips where vehicle_id=${trip.vehicle_id} and service_date<${dayString(trip.service_date)}::date and status<>'cancelled' and deleted_at is null and exists(select 1 from van_trip_load_lines l where l.trip_id=van_trips.id) order by service_date desc limit 1`;
  if (!from) refuse("There is no earlier load for this truck to copy");
  await requireCapability({ db, actor }, "van.manage", from.org_unit_id);
  const lines = await loadedLines(db, from.id);
  if (!lines.length) refuse("That trip had no load to copy");
  const made = await suggestionFromLines(db, trip, lines);
  let planId = plan?.id;
  if (plan) {
    await db`delete from van_planned_load_lines where planned_load_id=${plan.id}`;
    await db`update van_planned_loads set source='copy',copied_from_trip_id=${from.id},attention=${db.array(made.attention, "TEXT")},facts=${made.facts},edited_by=null,edited_at=null,updated_at=now() where id=${plan.id}`;
  } else {
    [{ id: planId }] =
      await db`insert into van_planned_loads(trip_id,state,source,copied_from_trip_id,attention,facts,created_by) values(${trip.id},'suggested','copy',${from.id},${db.array(made.attention, "TEXT")},${made.facts},${actor.subject}) returning id`;
  }
  for (const l of made.lines)
    await db`insert into van_planned_load_lines(planned_load_id,product_id,average_base,must_carry_base,ship_first_base,on_truck_base,depot_available_base,case_base,history_trips,suggested_base,flags)
      values(${planId},${l.productId},${l.averageBase},${l.mustCarryBase},${l.shipFirstBase},${l.onTruckBase},${l.depotFreeBase},${l.caseBase},${l.historyTrips ?? 0},${l.suggestedBase},${db.array(l.flags, "TEXT")})`;
  await audit(db, trip, actor, "van.load.copied", planId, { fromTripId: from.id });
  return { tripId: trip.id, plannedLoadId: planId };
}

// ------------------------------------------------------------------ the document

/** Turn the plan's quantities into an approved (stock-reserving) van load-out document and the trip's load rows. @param {any} db @param {any} actor @param {any} trip @param {any} plan */
async function openDocument(db, actor, trip, plan) {
  const lines = (await planLines(db, plan.id))
    .map((/** @type {any} */ l) => ({
      productId: l.product_id,
      quantityBase: Number(l.approved_base ?? l.suggested_base),
    }))
    .filter((/** @type {any} */ l) => l.quantityBase > 0);
  if (!lines.length)
    refuse("There is nothing to load. Add at least one product", "invalid_request");
  const [seller] =
    await db`select name from profiles where id=${trip.salesperson_profile_id}`;
  const [vehicle] = await db`select plate_number from vehicles where id=${trip.vehicle_id}`;
  const c = ctxFor(db, actor);
  const made = await createTransfer(c, {
    type: "van_load_out",
    sourceLocationId: trip.source_location_id,
    destinationLocationId: trip.truck_location_id,
    requestedBy: PLAN_SYSTEM,
    lines,
    driverName: trip.driver_name,
    vehiclePlate: vehicle?.plate_number,
    receiverName: seller?.name,
    sourceRef: `van_trip:${trip.id}`,
  });
  const row = await docRow(db, made.id);
  await approveTransfer(c, { idempotencyKey: `vanday:${made.id}:approve` }, row);
  await syncLoadRows(db, actor, trip, plan, made.id);
  return made;
}

/** Keep the trip's own load rows (what the phone and the old screens read) in step with the document. @param {any} db @param {any} actor @param {any} trip @param {any} plan @param {string} transferId */
async function syncLoadRows(db, actor, trip, plan, transferId) {
  let [load] =
    await db`select * from van_trip_loads where trip_id=${trip.id} and status<>'cancelled' and deleted_at is null for update`;
  if (!load) {
    [load] =
      await db`insert into van_trip_loads(organization_id,trip_id,load_number,status,created_by,stock_transfer_id) values(${trip.organization_id},${trip.id},1,'planned',${actor.subject},${transferId}) returning *`;
  } else
    await db`update van_trip_loads set stock_transfer_id=${transferId},updated_at=now() where id=${load.id}`;
  const allocs = await db`select a.product_id,a.lot_id,l.lot_number,a.reserved_base,a.dispatched_base from stock_transfer_allocations a left join inventory_lots l on l.id=a.lot_id where a.transfer_id=${transferId} order by a.product_id,l.expires_at nulls last,a.id`;
  await db`delete from van_trip_load_lines where load_id=${load.id} and actual_base is null`;
  let n = 0;
  for (const a of allocs) {
    const sent = Number(a.dispatched_base) > 0 ? Number(a.dispatched_base) : Number(a.reserved_base);
    if (sent <= 0) continue;
    const product = await productFor(db, a.product_id);
    n++;
    await db`insert into van_trip_load_lines(organization_id,load_id,trip_id,line_number,product_id,product_code,uom_code,quantity_scale,lot_id,lot_number,expected_base)
      values(${trip.organization_id},${load.id},${trip.id},${n},${a.product_id},${product.code},${product.base_code},${String(product.quantityScale)},${a.lot_id},${a.lot_number ?? null},${String(sent)})`;
  }
  await db`update van_planned_loads set stock_transfer_id=${transferId},load_id=${load.id},updated_at=now() where id=${plan.id}`;
  return load;
}

/** POST van/loads/approve-plan {tripIds:[...]} or {tripId}: approve suggested loads (one or the whole day). One truck failing does not stop the rest.
 * @param {any} db @param {any} actor @param {any} p */
export async function approvePlans(db, actor, p) {
  const ids = Array.isArray(p.tripIds) ? p.tripIds : p.tripId ? [p.tripId] : [];
  if (!ids.length || ids.length > 100) refuse("Choose 1 to 100 trips", "invalid_request");
  /** @type {any[]} */ const results = [];
  /** @type {string[]} */ const done = [];
  for (const id of ids) {
    try {
      await db.savepoint(async (/** @type {any} */ sp) => {
        const trip = await tripFor(sp, actor, uuid(id), "van.manage", true);
        const plan = await planOf(sp, trip.id, true);
        if (!plan) refuse("This trip has no suggested load yet");
        if (plan.state !== "suggested") {
          results.push({ tripId: trip.id, ok: true, note: "Already approved" });
          return;
        }
        if (trip.status !== "planned") refuse("The trip is no longer waiting for a load");
        const doc = await openDocument(sp, actor, trip, plan);
        await sp`update van_planned_loads set state='approved',approved_by=${actor.subject},approved_at=now(),updated_at=now() where id=${plan.id}`;
        await sp`update van_trips set status='loading',updated_at=now() where id=${trip.id}`;
        await audit(sp, trip, actor, "van.load.plan_approved", plan.id, { transferNumber: doc.number });
        results.push({ tripId: trip.id, ok: true, number: doc.number });
        done.push(trip.id);
      });
    } catch (e) {
      results.push({
        tripId: id,
        ok: false,
        message: e instanceof ApiError ? e.message : "Could not approve this load",
      });
    }
  }
  return { tripIds: done, approved: done.length, failed: results.filter((r) => !r.ok).length, results };
}

/** POST van/loads/amend {tripId, lines}: top up or trim before dispatch. The old document is cancelled (its reservation freed) and a new one made. @param {any} db @param {any} actor @param {any} p */
export async function amendLoad(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "van.manage", true);
  const plan = await planOf(db, trip.id, true);
  if (!plan || !["approved", "picking"].includes(plan.state))
    refuse("A load can be changed only before it is dispatched");
  await applyLines(db, plan, trip, p.lines);
  const old = await docRow(db, plan.stock_transfer_id);
  await cancelTransfer(ctxFor(db, actor), { idempotencyKey: `vanday:${old.id}:cancel` }, old);
  const doc = await openDocument(db, actor, trip, plan);
  await db`update van_planned_loads set state='approved',edited_by=${actor.subject},edited_at=now(),updated_at=now() where id=${plan.id}`;
  await audit(db, trip, actor, "van.load.amended", plan.id, { transferNumber: doc.number });
  return { tripId: trip.id, plannedLoadId: plan.id, number: doc.number };
}

/** The clerk's scope on the depot the load leaves. @param {any} db @param {any} actor @param {any} trip */
async function clerkGate(db, actor, trip) {
  await requireCapability({ db, actor }, "inventory.write", trip.org_unit_id);
  await locationFor(db, actor, trip.source_location_id, "inventory.write");
  if (actor.profileId === trip.salesperson_profile_id)
    throw forbidden("The seller cannot pick or dispatch their own load");
}

/** POST van/loads/pick {tripId, lines?:[{productId, pickedBase}]}: the clerk's pick list. Top-up allowed until dispatch. @param {any} db @param {any} actor @param {any} p */
export async function pickLoad(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "inventory.write", true);
  await clerkGate(db, actor, trip);
  const plan = await planOf(db, trip.id, true);
  if (!plan || !["approved", "picking"].includes(plan.state))
    refuse("This load is not ready to pick");
  const row = await docRow(db, plan.stock_transfer_id);
  const docLines = await db`select id,product_id from stock_transfer_lines where transfer_id=${row.id}`;
  const lines = Array.isArray(p.lines)
    ? p.lines.map((/** @type {any} */ l) => {
        const dl = docLines.find((/** @type {any} */ d) => d.product_id === l.productId);
        if (!dl) refuse("That product is not on this load");
        return { lineId: dl.id, pickedBase: qty(l.pickedBase, "Picked quantity") };
      })
    : undefined;
  await pickTransfer(ctxFor(db, actor), { idempotencyKey: `vanday:${row.id}:pick`, lines }, row);
  const [clerk] = await db`select name from profiles where id=${actor.profileId}`;
  await db`update van_planned_loads set state='picking',clerk_user_id=${actor.userId},clerk_name=${clerk?.name ?? null},updated_at=now() where id=${plan.id}`;
  await audit(db, trip, actor, "van.load.picking", plan.id);
  return { tripId: trip.id, plannedLoadId: plan.id, number: row.transfer_number };
}

/** POST van/loads/dispatch {tripId, driverName?, vehiclePlate?}: the clerk signs; stock moves to In transit. @param {any} db @param {any} actor @param {any} p */
export async function dispatchLoad(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "inventory.write", true);
  await clerkGate(db, actor, trip);
  const plan = await planOf(db, trip.id, true);
  if (!plan || !["approved", "picking"].includes(plan.state))
    refuse("This load is not ready to dispatch");
  const row = await docRow(db, plan.stock_transfer_id);
  const sent = await dispatchTransfer(
    ctxFor(db, actor),
    {
      idempotencyKey: `vanday:${row.id}:dispatch`,
      driverName: p.driverName ?? row.driver_name,
      vehiclePlate: p.vehiclePlate ?? row.vehicle_plate,
      receiverName: row.receiver_name,
    },
    row,
  );
  const [clerk] = await db`select name from profiles where id=${actor.profileId}`;
  await db`update van_planned_loads set state='dispatched',clerk_user_id=${actor.userId},clerk_name=${clerk?.name ?? null},clerk_signed_at=now(),updated_at=now() where id=${plan.id}`;
  await syncLoadRows(db, actor, trip, plan, row.id);
  await audit(db, trip, actor, "van.load.dispatched", plan.id, { number: row.transfer_number });
  return { tripId: trip.id, plannedLoadId: plan.id, number: row.transfer_number, movementId: sent.movementId };
}

// ------------------------------------------------------------------ accept, recount, decide

/** What was sent, per batch: the allocation rows of the document. @param {any} db @param {string} transferId */
const sentRows = (db, transferId) =>
  db`select a.id,a.transfer_line_id,a.product_id,a.lot_id,l.lot_number,a.dispatched_base,a.unit_cost_minor,a.quantity_scale from stock_transfer_allocations a left join inventory_lots l on l.id=a.lot_id where a.transfer_id=${transferId} and a.dispatched_base>0 order by a.product_id,l.expires_at nulls last,a.id`;
/** @param {{lot_id:string|null, product_id:string}} a */
const keyOf = (a) => `${a.product_id}:${a.lot_id ?? ""}`;

/** Parse a count `[{productId, lotId?, actualBase|countedBase, reason?}]` against what was sent; every sent batch must be counted. @param {any[]} sent @param {any} input @param {string} field */
function readCounts(sent, input, field) {
  if (!Array.isArray(input) || input.length > 400)
    refuse("Count every load line", "invalid_request");
  /** @type {Map<string, {base:number, reason:string|null}>} */ const got = new Map();
  for (const l of input) {
    const key = `${uuid(l.productId)}:${l.lotId ?? ""}`;
    if (got.has(key)) refuse("Load line is repeated", "invalid_request");
    got.set(key, { base: qty(l[field], "Counted quantity"), reason: l.reason ?? null });
  }
  for (const k of got.keys())
    if (!sent.some((a) => keyOf(a) === k))
      refuse("That product or batch is not on this load", "invalid_request");
  for (const a of sent)
    if (!got.has(keyOf(a))) refuse("Count every load line", "invalid_request");
  return got;
}

/** How big is the difference, in the two measures the tolerance uses: pesos and cases. @param {any} db @param {any[]} sent @param {Map<string,{base:number}>} counts */
async function measure(db, sent, counts) {
  let centavos = 0n,
    cases = 0,
    pieces = 0;
  for (const a of sent) {
    const diff = Math.abs(Number(counts.get(keyOf(a))?.base ?? 0) - Number(a.dispatched_base));
    if (!diff) continue;
    pieces += diff;
    centavos += (BigInt(a.unit_cost_minor) * BigInt(diff)) / BigInt(a.quantity_scale || 1);
    const product = await productFor(db, a.product_id);
    cases += Number(product.caseBase) > 0 ? diff / Number(product.caseBase) : diff;
  }
  return { centavos: Number(centavos), cases, pieces };
}

/** Post the counted load: In transit -> truck for what was counted, then settle the difference.
 * `how`: within_tolerance (the document closes itself), both_agreed (a system sign-off, nobody above the clerk and seller needed),
 * supervisor (the deciding person). @param {any} db @param {any} o */
async function postCounted(db, o) {
  const { trip, plan, doc, counts, how, round } = o;
  const sent = await sentRows(db, doc.id);
  const lines = sent.map((/** @type {any} */ a) => ({
    lineId: a.transfer_line_id,
    batchId: a.lot_id ?? undefined,
    receivedGoodBase: counts.get(keyOf(a)).base,
    receivedDamagedBase: 0,
  }));
  const seller = { userId: trip.salesperson_subject, profileId: trip.salesperson_profile_id };
  const cs = ctxFor(db, seller);
  const key = `vanday:${doc.id}:recv:${round}`;
  let r = await receiveTransfer(cs, { idempotencyKey: key, final: true, lines }, doc);
  const movementId = r.movementId ?? null;
  let fresh = await docRow(db, doc.id);
  if (fresh.status === "received") {
    await closeTransfer(cs, { idempotencyKey: `${key}:close` }, fresh);
  } else if (fresh.status === "review_needed") {
    const short = sent.some((/** @type {any} */ a) => counts.get(keyOf(a)).base < Number(a.dispatched_base));
    // Supervisor: the deciding person, a third party to the clerk and the seller (the document refuses its own sender and receiver).
    // Agreed: the clerk and the seller counted the same on their own devices; transfers.js proves that (two different people,
    // the seller received it, same numbers, equal to what was received) and records both signatures. Nobody's check is skipped.
    if (how === "supervisor")
      await resolveVariance(
        ctxFor(db, o.supervisor),
        {
          idempotencyKey: `${key}:resolve`,
          chargeTo: o.chargeTo ?? "dispatch_side",
          shortReasonCode: "SHORT-PICK",
          overReasonCode: "FOUND",
          note: o.note ?? "Decided by the supervisor",
        },
        fresh,
      );
    else {
      const clerkCounts = o.clerkCounts ?? counts;
      await resolveVarianceByAgreement(db, ORGANIZATION, doc.id, {
        clerkId: o.clerk.userId,
        sellerId: seller.userId,
        lines: sent.map((/** @type {any} */ a) => ({
          productId: a.product_id,
          lotId: a.lot_id,
          sellerBase: counts.get(keyOf(a)).base,
          clerkBase: clerkCounts.get(keyOf(a)).base,
        })),
        chargeTo: o.chargeTo ?? "dispatch_side",
        shortReasonCode: "SHORT-PICK",
        overReasonCode: "FOUND",
        note: "Clerk and seller counted the same on their own devices",
        idempotencyKey: `${key}:resolve`,
      });
    }
    void short;
  }
  fresh = await docRow(db, doc.id);
  // The trip's own load rows and status, which the phone and the old screens read.
  const [load] = await db`select * from van_trip_loads where id=${plan.load_id} for update`;
  for (const a of sent) {
    const c = counts.get(keyOf(a));
    await db`update van_trip_load_lines set actual_base=${String(c.base)},discrepancy_reason=${c.base === Number(a.dispatched_base) ? null : (LOAD_REASONS.includes(c.reason) ? c.reason : c.base < Number(a.dispatched_base) ? "short_loaded" : "over_loaded")},updated_at=now()
      where load_id=${load.id} and product_id=${a.product_id} and lot_id is not distinct from ${a.lot_id}`;
  }
  await db`update van_trip_loads set status='posted',movement_id=${movementId},updated_at=now() where id=${load.id}`;
  await db`update van_trips set status='loaded',updated_at=now() where id=${trip.id}`;
  // What the settlement and the stock count expect to find on the truck is built from these events: the COUNTED load.
  /** @type {Map<string, bigint>} */ const perProduct = new Map();
  for (const a of sent)
    perProduct.set(a.product_id, (perProduct.get(a.product_id) ?? 0n) + BigInt(counts.get(keyOf(a)).base));
  await explainStock(
    db,
    trip,
    load.id,
    "load",
    [...perProduct].filter(([, q]) => q > 0n).map(([productId, delta]) => ({ productId, delta })),
  );
  const m = await measure(db, sent, counts);
  await db`update van_planned_loads set state='accepted',agreement=${how},agreed_at=now(),difference_value_centavos=${m.centavos},updated_at=now() where id=${plan.id}`;
  return { status: fresh.status, movementId, differenceCentavos: m.centavos };
}

/** The seller's count (op `load.accept`). Runs inside the phone-operation transaction; the trip and device were already checked.
 * @param {any} db @param {any} trip @param {any} actor @param {any} device @param {any} p @param {any} op */
export async function acceptLoad(db, trip, actor, device, p, op) {
  const plan = await planOf(db, trip.id, true);
  if (!plan?.stock_transfer_id) refuse("This trip has no load document to accept");
  if (p.loadId && plan.load_id !== p.loadId) refuse("That is not this trip's load", "invalid_request");
  if (plan.state === "accepted") return { entityId: plan.load_id, state: "accepted" };
  if (plan.state === "recount")
    refuse("Your count was sent. Waiting for the clerk to recount", "evidence_pending_review");
  if (plan.state !== "dispatched")
    refuse("The clerk has not dispatched this load yet");
  const doc = await docRow(db, plan.stock_transfer_id);
  const sent = await sentRows(db, doc.id);
  const counts = readCounts(sent, p.lines, "actualBase");
  for (const [, v] of counts)
    if (v.reason !== null && !LOAD_REASONS.includes(v.reason))
      refuse("Choose a supported reason", "invalid_request");
  for (const a of sent) {
    const c = /** @type {any} */ (counts.get(keyOf(a)));
    if (c.base !== Number(a.dispatched_base) && !c.reason)
      refuse("Say why the count differs on each line that does", "invalid_request");
  }
  const [{ r }] =
    await db`select coalesce(max(round),0)::int as r from van_load_counts where planned_load_id=${plan.id}`;
  const round = r + 1;
  await db`insert into van_load_counts(planned_load_id,round,side,counted_by,profile_id,device_id,counted_at,lines,note)
    values(${plan.id},${round},'seller',${actor.subject},${actor.profileId},${device.id},now(),${{ items: [...counts].map(([k, v]) => ({ key: k, ...v })) }},${text(p.note, 300)})`;
  for (const a of sent) {
    const c = /** @type {any} */ (counts.get(keyOf(a)));
    await db`update van_trip_load_lines set actual_base=${String(c.base)},discrepancy_reason=${c.base === Number(a.dispatched_base) ? null : c.reason},updated_at=now() where load_id=${plan.load_id} and product_id=${a.product_id} and lot_id is not distinct from ${a.lot_id}`;
  }
  await db`update van_trip_loads set confirmed_by=${actor.subject},confirmed_at=now(),confirmed_device_id=${device.id},confirm_request_id=${op.clientOpId},approved_by=null,approved_at=null,updated_at=now() where id=${plan.load_id}`;
  await db`update van_planned_loads set seller_signed_at=now(),updated_at=now() where id=${plan.id}`;
  const m = await measure(db, sent, counts);
  const tol = await toleranceFor(db, ORGANIZATION, "load_out_difference", Date.now());
  const inside = m.pieces === 0 || withinTolerance(tol, { centavos: m.centavos, cases: m.cases });
  if (inside) {
    const done = await postCounted(db, { trip, plan, doc, counts, how: "within_tolerance", round });
    return { entityId: plan.load_id, state: "accepted", agreement: "within_tolerance", ...done };
  }
  await db`update van_planned_loads set state='recount',difference_value_centavos=${m.centavos},updated_at=now() where id=${plan.id}`;
  return { entityId: plan.load_id, state: "recount", differenceCentavos: m.centavos };
}

/** POST van/loads/recount {tripId, agree?:true, lines?:[{productId, lotId?, countedBase}]}: the clerk counts the truck on their own device.
 * Same as the seller: accepted, no supervisor. Different: Decide. @param {any} db @param {any} actor @param {any} p */
export async function recountLoad(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "inventory.write", true);
  await clerkGate(db, actor, trip);
  const plan = await planOf(db, trip.id, true);
  if (!plan || plan.state !== "recount")
    refuse("There is no load waiting for a recount on this trip");
  const doc = await docRow(db, plan.stock_transfer_id);
  const sent = await sentRows(db, doc.id);
  const [seller] =
    await db`select lines,round from van_load_counts where planned_load_id=${plan.id} and side='seller' order by round desc limit 1`;
  const sellerCounts = new Map(seller.lines.items.map((/** @type {any} */ l) => [l.key, { base: l.base, reason: l.reason }]));
  const counts = p.agree === true ? sellerCounts : readCounts(sent, p.lines, "countedBase");
  await db`insert into van_load_counts(planned_load_id,round,side,counted_by,profile_id,counted_at,lines,note)
    values(${plan.id},${seller.round},'clerk',${actor.subject},${actor.profileId},now(),${{ items: [...counts].map(([k, v]) => ({ key: k, ...v })) }},${text(p.note, 300)})`;
  await db`update van_planned_loads set clerk_signed_at=now(),clerk_user_id=${actor.userId},updated_at=now() where id=${plan.id}`;
  const same = sent.every((/** @type {any} */ a) => /** @type {any} */ (counts.get(keyOf(a))).base === /** @type {any} */ (sellerCounts.get(keyOf(a))).base);
  if (!same) {
    await db`update van_planned_loads set state='disputed',updated_at=now() where id=${plan.id}`;
    await db`update van_trip_loads set status='discrepancy',updated_at=now() where id=${plan.load_id}`;
    await audit(db, trip, actor, "van.load.disputed", plan.id);
    return { tripId: trip.id, state: "disputed" };
  }
  const done = await postCounted(db, { trip, plan, doc, counts: sellerCounts, how: "both_agreed", round: seller.round, clerk: { userId: actor.userId, profileId: actor.profileId }, clerkCounts: counts });
  await audit(db, trip, actor, "van.load.agreed", plan.id);
  return { tripId: trip.id, state: "accepted", agreement: "both_agreed", ...done };
}

/** The existing load-difference approval (van/loads/approve) for a load that has a document. approve posts the chosen count
 * (`basis`: seller or clerk); reject sends it back for both to count again. @param {any} db @param {any} actor @param {any} trip @param {any} load @param {"approve"|"reject"} decision @param {string|null} note @param {any} p */
export async function decideLoadDocument(db, actor, trip, load, decision, note, p) {
  const plan = await planOf(db, trip.id, true);
  if (!plan || plan.load_id !== load.id) refuse("This load has no document to decide");
  if (plan.state !== "disputed" && plan.state !== "recount")
    refuse("This load is not waiting for a decision");
  if (decision === "reject") {
    await db`update van_trip_loads set status='planned',approved_by=null,approved_at=null,approval_note=${note},updated_at=now() where id=${load.id}`;
    await db`update van_planned_loads set state='dispatched',updated_at=now() where id=${plan.id}`;
    await audit(db, trip, actor, "van.load.rejected", load.id, { note });
    return { entityId: load.id };
  }
  const basis = p.basis === "clerk" ? "clerk" : "seller";
  const [row] =
    await db`select lines,round from van_load_counts where planned_load_id=${plan.id} and side=${basis} order by round desc limit 1`;
  if (!row) refuse(basis === "clerk" ? "The clerk has not recounted yet" : "The seller has not counted yet");
  const counts = new Map(row.lines.items.map((/** @type {any} */ l) => [l.key, { base: l.base, reason: l.reason }]));
  const doc = await docRow(db, plan.stock_transfer_id);
  await db`update van_trip_loads set approved_by=${actor.subject},approved_at=now(),approval_note=${note},updated_at=now() where id=${load.id}`;
  const done = await postCounted(db, {
    trip, plan, doc, counts, how: "supervisor", round: row.round,
    supervisor: { userId: actor.userId, profileId: actor.profileId },
    chargeTo: ["dispatch_side", "receive_side", "carrier", "driver"].includes(p.chargeTo) ? p.chargeTo : "dispatch_side",
    note,
  });
  await audit(db, trip, actor, "van.load.approved", load.id);
  return { entityId: load.id, ...done };
}

/** Cancel the plan and free the reservation when a trip is cancelled before the load left the depot. @param {any} db @param {any} actor @param {any} trip */
export async function cancelPlanForTrip(db, actor, trip) {
  const plan = await planOf(db, trip.id, true);
  if (!plan) return;
  if (["dispatched", "recount", "disputed", "accepted"].includes(plan.state))
    refuse("The load has already left the depot. Take it back through a load-in first");
  if (plan.stock_transfer_id && ["approved", "picking"].includes(plan.state)) {
    const doc = await docRow(db, plan.stock_transfer_id);
    await cancelTransfer(ctxFor(db, actor), { idempotencyKey: `vanday:${doc.id}:cancel` }, doc);
  }
  await db`update van_planned_loads set state='cancelled',updated_at=now() where id=${plan.id}`;
}
/** The old manual planner replaced the suggestion; drop the plan so there is one source of truth. @param {any} db @param {string} tripId */
export async function supersedePlan(db, tripId) {
  await db`update van_planned_loads set state='cancelled',updated_at=now() where trip_id=${tripId} and state='suggested'`;
}
export { OPEN_STATES };
