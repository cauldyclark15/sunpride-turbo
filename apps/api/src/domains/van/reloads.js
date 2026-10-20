import { postMovement } from "../inventory/posting.js";
import { tripFor, notSelf } from "./access.js";
import { productFor, explainStock, audit, assertNotCounted } from "./facts.js";
import { uuid, text, choice, refuse } from "./model.js";
import { canonicalJson } from "../../core/util.js";

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
    lines = [];
  if (kind === "dispatched") {
    if (
      !(
        await db`select 1 from van_reload_events where request_id=${request.id} and kind='approved'`
      ).length
    )
      refuse("Approve this reload before dispatch");
    const input = [];
    for (const l of request.facts.lines) {
      const product = await productFor(db, l.productId);
      input.push({
        productId: product.id,
        fromLocationId: trip.source_location_id,
        toLocationId: trip.truck_location_id,
        fromStockStatus: "available",
        toStockStatus: "in_transit",
        quantityBase: Number(l.quantityBase),
        uom: product.base_code,
      });
    }
    const movement = await postMovement(db, {
      kind: "transfer_ship",
      sourceType: "van_reload",
      sourceId: request.id,
      idempotencyKey: `van:reload:ship:${request.id}`,
      occurredAt: Date.now(),
      organizationId: trip.organization_id,
      actor: { profileId: actor.profileId, userId: actor.userId },
      authorizedLocations: [trip.source_location_id, trip.truck_location_id],
      lines: input,
    });
    movementId = movement.movementId;
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
  await db`insert into van_reload_events(request_id,kind,facts,actor_profile_id,movement_id) values(${request.id},${kind},${{ note, lines }},${actor.profileId},${movementId})`;
  await audit(db, trip, actor, `van.reload.${kind}`, request.id, { note });
  return { tripId: trip.id, requestId: request.id, movementId };
}

/** F-121 receipt requires the exact independently dispatched batches; a request never adds sellable stock.
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
  if (canonicalJson(p.lines) !== canonicalJson(dispatch.facts.lines))
    refuse(
      "Scan the exact dispatched batches and quantities",
      "stock_conflict",
    );
  const lines = [];
  for (const l of dispatch.facts.lines) {
    const product = await productFor(db, l.productId);
    lines.push({
      productId: l.productId,
      fromLocationId: trip.truck_location_id,
      toLocationId: trip.truck_location_id,
      fromStockStatus: "in_transit",
      toStockStatus: "available",
      quantityBase: Number(l.quantityBase),
      uom: product.base_code,
      lotId: l.lotId,
    });
  }
  const posted = await postMovement(db, {
    kind: "transfer_receive",
    sourceType: "van_reload",
    sourceId: id,
    idempotencyKey: `van:${opId}`,
    occurredAt: p.deviceTime,
    organizationId: trip.organization_id,
    actor: { profileId: actor.profileId, userId: actor.userId },
    authorizedLocations: [trip.truck_location_id],
    lines,
  });
  await db`insert into van_reload_events(request_id,kind,facts,actor_profile_id,movement_id) values(${id},'received',${{ lines: dispatch.facts.lines, note: text(p.note) }},${actor.profileId},${posted.movementId})`;
  await explainStock(
    db,
    trip,
    id,
    "reload",
    lines.map((l) => ({
      productId: l.productId,
      delta: BigInt(l.quantityBase),
    })),
  );
  return { entityId: id, movementId: posted.movementId };
}
