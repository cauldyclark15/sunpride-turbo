import { document } from "../inventory/common.js";
import { postMovement } from "../inventory/posting.js";
import {
  approveTransfer,
  createTransfer,
  dispatchTransfer,
  receiveTransfer,
} from "../inventory/transfers.js";
import { tripFor, notSelf } from "./access.js";
import { productFor, explainStock, audit, assertNotCounted } from "./facts.js";
import { uuid, text, choice, refuse } from "./model.js";
import { canonicalJson } from "../../core/util.js";

/** The reload is one movement document (type van reload): approve reserves at the depot, dispatch moves it to the
 * depot's In transit location (never "in transit on the truck"), and the seller's receipt posts good / damaged / short.
 * @param {any} db @param {any} actor @param {number} [now] */
const docContext = (db, actor, now = Date.now()) => ({
  db,
  actor,
  now,
  trusted: true,
});

/** Make (or find) the movement document behind a reload request. Reloads approved before documents existed get theirs here.
 * @param {any} db @param {any} actor @param {any} trip @param {any} request @param {string} idemKey */
async function reloadDocument(db, actor, trip, request, idemKey) {
  const [existing] =
    await db`select id from stock_transfers where organization_id=${trip.organization_id} and source_ref=${`van_reload:${request.id}`} and status<>'cancelled' limit 1`;
  if (existing) return document(db, "stock_transfers", existing.id);
  const [seller] =
    await db`select user_id from profiles where id=${request.recorded_by}`;
  const [vehicle] =
    await db`select plate_number from vehicles where id=${trip.vehicle_id}`;
  const c = docContext(db, actor);
  const made = await createTransfer(c, {
    type: "van_reload",
    sourceLocationId: trip.source_location_id,
    destinationLocationId: trip.truck_location_id,
    lines: request.facts.lines.map((/** @type {any} */ l) => ({
      productId: l.productId,
      quantityBase: Number(l.quantityBase),
    })),
    note: request.facts.note ?? null,
    sourceRef: `van_reload:${request.id}`,
    requestedBy: seller?.user_id ?? null,
    driverName: trip.driver_name ?? null,
    vehiclePlate: vehicle?.plate_number ?? null,
  });
  const row = await document(db, "stock_transfers", made.id);
  await approveTransfer(c, { idempotencyKey: idemKey }, row);
  return document(db, "stock_transfers", made.id);
}

/** F-121 office approval and dispatch have separate immutable events. @param {any} db @param {any} actor @param {any} p */
export async function reloadAction(db, actor, p) {
  const trip = await tripFor(
    db,
    actor,
    uuid(p.tripId),
    "van.load.approve",
    true,
  );
  notSelf(actor, trip);
  await assertNotCounted(db, trip.id);
  if (trip.status !== "active") refuse("Reloads require an active trip");
  const [request] =
    await db`select * from van_trip_observations where id=${uuid(p.requestId)} and trip_id=${trip.id} and kind='reload_request'`;
  if (!request) refuse("Choose a reload request from this trip");
  const kind = choice(p.action, ["approved", "dispatched"]),
    note = text(p.note, 300, true);
  if (
    (
      await db`select 1 from van_reload_events where request_id=${request.id} and kind=${kind}`
    ).length
  )
    refuse("This reload transition is already recorded");
  let movementId = null,
    lines = [],
    transferId = null,
    transferNumber = null;
  const idemKey = `van:reload:${request.id}`;
  if (kind === "approved") {
    const row = await reloadDocument(db, actor, trip, request, idemKey);
    transferId = row.id;
    transferNumber = row.transfer_number;
  }
  if (kind === "dispatched") {
    if (
      !(
        await db`select 1 from van_reload_events where request_id=${request.id} and kind='approved'`
      ).length
    )
      refuse("Approve this reload before dispatch");
    const row = await reloadDocument(db, actor, trip, request, idemKey);
    transferId = row.id;
    transferNumber = row.transfer_number;
    const sent = await dispatchTransfer(
      docContext(db, actor),
      { idempotencyKey: idemKey },
      row,
    );
    movementId = sent.movementId;
    const allocations =
      await db`select a.product_id as "productId",a.lot_id as "lotId",a.quantity_base::text as "quantityBase",l.lot_number as batch,l.expires_at as expiry,l.quality_status as "qualityStatus" from inventory_allocations a left join inventory_lots l on l.id=a.lot_id where a.movement_id=${movementId} order by a.allocation_sequence`;
    lines = allocations.length
      ? allocations.map((/** @type {any} */ l) => {
          const { expiry, ...f } = l;
          return {
            ...f,
            expiresAt: expiry ? new Date(expiry).getTime() : null,
          };
        })
      : request.facts.lines.map((/** @type {any} */ l) => ({
          ...l,
          lotId: null,
          batch: null,
          expiresAt: null,
          qualityStatus: "released",
        }));
  }
  await db`insert into van_reload_events(request_id,kind,facts,actor_profile_id,movement_id) values(${request.id},${kind},${{ note, lines, transferId, transferNumber }},${actor.profileId},${movementId})`;
  await audit(db, trip, actor, `van.reload.${kind}`, request.id, { note });
  return {
    tripId: trip.id,
    requestId: request.id,
    movementId,
    transferId,
    transferNumber,
  };
}

/** The seller counts what arrived: good, damaged, or missing, by batch. Anything short or damaged is a variance on the same
 * document (it does not block the trip), instead of the old "scan the exact dispatched batches" rule.
 * Lines: `[{productId, lotId, receivedGoodBase?, receivedDamagedBase?, reasonCode?, photoCount?}]`; the v1 shape
 * (the dispatched lines echoed back) still means everything arrived good.
 * @param {any} db @param {any} trip @param {any} actor @param {any} p @param {string} opId
 */
export async function receiveReload(db, trip, actor, p, opId) {
  await assertNotCounted(db, trip.id);
  const id = uuid(p.requestId);
  const [dispatch] =
    await db`select e.* from van_reload_events e join van_trip_observations o on o.id=e.request_id where e.request_id=${id} and o.trip_id=${trip.id} and e.kind='dispatched'`;
  if (
    !dispatch ||
    (
      await db`select 1 from van_reload_events where request_id=${id} and kind='received'`
    ).length
  )
    refuse("Download an unreceived dispatch before receiving reload stock");
  const [request] =
    await db`select * from van_trip_observations where id=${id}`;
  // IP-INT2FIX: a reload dispatched by the old code (stock moved depot -> truck "in transit", no document) is received the
  // old way, straight from the truck's in-transit stock. Building a document now would reserve depot stock a second time.
  if (await isLegacyDispatch(db, trip, request, dispatch))
    return receiveLegacyReload(db, trip, actor, p, opId, dispatch);
  const row = await reloadDocument(
    db,
    actor,
    trip,
    request,
    `van:reload:${id}`,
  );
  const legacy = canonicalJson(p.lines) === canonicalJson(dispatch.facts.lines);
  const given = Array.isArray(p.lines) ? p.lines : [];
  if (!legacy && !given.length) refuse("Count what arrived on each line");
  const transferLines =
    await db`select * from stock_transfer_lines where transfer_id=${row.id}`;
  /** @type {any[]} */ const receive = [];
  for (const l of legacy ? dispatch.facts.lines : given) {
    const line = transferLines.find(
      (/** @type {any} */ t) => t.product_id === l.productId,
    );
    if (!line) refuse("That product was not on this reload", "stock_conflict");
    receive.push({
      lineId: line.id,
      batchId: l.lotId ?? undefined,
      receivedGoodBase: legacy
        ? Number(l.quantityBase)
        : Number(l.receivedGoodBase ?? 0),
      receivedDamagedBase: legacy ? 0 : Number(l.receivedDamagedBase ?? 0),
      reasonCode: l.reasonCode,
      photoCount: l.photoCount,
      note: l.note,
    });
  }
  const at = Number.isSafeInteger(p.deviceTime) ? p.deviceTime : Date.now();
  const result = await receiveTransfer(
    docContext(db, actor, at),
    {
      idempotencyKey: `van:${opId}`,
      lines: receive,
      final: true,
      note: p.note ? String(p.note) : undefined,
    },
    row,
    { authorized: [row.in_transit_location_id, trip.truck_location_id] },
  );
  const got =
    await db`select product_id,sum(received_good_base)::text as good,sum(received_damaged_base)::text as damaged,sum(received_hold_base)::text as hold from stock_transfer_allocations where transfer_id=${row.id} group by product_id`;
  /** @type {any[]} */ const explained = [];
  for (const g of got) {
    for (const [status, qty] of /** @type {Array<[string,string]>} */ ([
      ["available", g.good],
      ["damaged", g.damaged],
      ["quality_hold", g.hold],
    ]))
      if (BigInt(qty) > 0n)
        explained.push({ productId: g.product_id, status, delta: BigInt(qty) });
  }
  await db`insert into van_reload_events(request_id,kind,facts,actor_profile_id,movement_id) values(${id},'received',${{ lines: dispatch.facts.lines, received: receive, note: text(p.note), transferId: row.id, transferStatus: result.status, varianceStatus: result.varianceStatus }},${actor.profileId},${result.movementId})`;
  await explainStock(db, trip, id, "reload", explained);
  return { entityId: id, movementId: result.movementId };
}

/** Dispatched before movement documents existed: the event has a movement but no document, and no document was made since.
 * @param {any} db @param {any} trip @param {any} request @param {any} dispatch */
async function isLegacyDispatch(db, trip, request, dispatch) {
  if (!dispatch.movement_id || dispatch.facts?.transferId) return false;
  const [doc] =
    await db`select id from stock_transfers where organization_id=${trip.organization_id} and source_ref=${`van_reload:${request.id}`} and status<>'cancelled' limit 1`;
  return !doc;
}

/** The pre-document receipt: good pieces become available, damaged ones damaged, both from the truck's in-transit stock.
 * A short count cannot be recorded without a document, so it is refused in plain words and the stock stays in transit.
 * @param {any} db @param {any} trip @param {any} actor @param {any} p @param {string} opId @param {any} dispatch */
async function receiveLegacyReload(db, trip, actor, p, opId, dispatch) {
  const id = uuid(p.requestId);
  const sent = /** @type {any[]} */ (dispatch.facts.lines);
  const echo = canonicalJson(p.lines) === canonicalJson(sent);
  const given = Array.isArray(p.lines) ? p.lines : [];
  if (!echo && !given.length) refuse("Count what arrived on each line");
  /** @type {any[]} */ const lines = [];
  /** @type {any[]} */ const explained = [];
  for (const l of sent) {
    const found = echo
      ? l
      : given.find(
          (/** @type {any} */ g) =>
            g.productId === l.productId &&
            (g.lotId ?? null) === (l.lotId ?? null),
        );
    if (!found) refuse("Count every product that was sent on this reload");
    const total = Number(l.quantityBase);
    const good = echo ? total : Number(found.receivedGoodBase ?? 0);
    const damaged = echo ? 0 : Number(found.receivedDamagedBase ?? 0);
    if (
      !Number.isInteger(good) ||
      !Number.isInteger(damaged) ||
      good < 0 ||
      damaged < 0 ||
      good + damaged !== total
    )
      refuse(
        "This reload was sent before the update, so it has to be received in full. Count the good and damaged pieces so they add up to what was sent, or ask the office.",
        "stock_conflict",
      );
    const product = await productFor(db, l.productId);
    for (const [qty, status] of /** @type {Array<[number,string]>} */ ([
      [good, "available"],
      [damaged, "damaged"],
    ]))
      if (qty > 0) {
        lines.push({
          productId: l.productId,
          fromLocationId: trip.truck_location_id,
          toLocationId: trip.truck_location_id,
          fromStockStatus: "in_transit",
          toStockStatus: status,
          quantityBase: qty,
          uom: product.base_code,
          lotId: l.lotId,
        });
        explained.push({ productId: l.productId, status, delta: BigInt(qty) });
      }
  }
  const posted = await postMovement(db, {
    kind: "transfer_receive",
    sourceType: "van_reload",
    sourceId: id,
    idempotencyKey: `van:${opId}`,
    occurredAt: Number.isSafeInteger(p.deviceTime) ? p.deviceTime : Date.now(),
    organizationId: trip.organization_id,
    actor: { profileId: actor.profileId, userId: actor.userId },
    authorizedLocations: [trip.truck_location_id],
    lines,
  });
  await db`insert into van_reload_events(request_id,kind,facts,actor_profile_id,movement_id) values(${id},'received',${{ lines: sent, note: text(p.note), legacy: true }},${actor.profileId},${posted.movementId})`;
  await explainStock(db, trip, id, "reload", explained);
  return { entityId: id, movementId: posted.movementId };
}
