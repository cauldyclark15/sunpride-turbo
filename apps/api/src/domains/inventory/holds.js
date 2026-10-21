import { postMovement } from "./posting.js";
import { stockLock, invalid } from "./common.js";
/** F-614: recall uses the existing reservation and movement authorities, never edits balances.
 * Caller owns the recall transaction and national authorization. @param {any} c @param {string} recallId @param {string[]} lotIds */
export async function holdRecallLots(c, recallId, lotIds) {
  await stockLock(c.db, "sunpride");
  for (const lot of lotIds)
    await c.db`insert into inventory_lot_holds(lot_id,source_type,source_id,actor_subject) values(${lot},'retail_recall',${recallId},${c.actor.subject}) on conflict(lot_id,source_type,source_id) do nothing`;
  const reserved =
    await c.db`select l.*,r.status from inventory_reservation_lines l join inventory_reservations r on r.id=l.reservation_id where l.lot_id in ${c.db(lotIds)} and l.reserved_base>l.consumed_base+l.released_base and r.status in ('active','partially_consumed') order by l.id limit 501 for update of l,r`;
  if (reserved.length > 500)
    invalid("Split the recall: more than 500 active reservation lines");
  const common = {
    organizationId: "sunpride",
    sourceType: "retail_recall",
    sourceId: recallId,
    actor: c.actor,
    occurredAt: c.now,
  };
  for (const line of reserved) {
    await postMovement(c.db, {
      ...common,
      kind: "reservation_release",
      idempotencyKey: `recall:${recallId}:reservation:${line.id}`,
      lines: [
        {
          productId: line.product_id,
          lotId: line.lot_id,
          fromLocationId: line.location_id,
          toLocationId: null,
          uom: "base",
          quantityBase:
            Number(line.reserved_base) -
            Number(line.consumed_base) -
            Number(line.released_base),
        },
      ],
    });
    await c.db`update inventory_reservation_lines set released_base=reserved_base-consumed_base where id=${line.id}`;
    await c.db`update inventory_reservations r set status='released' where id=${line.reservation_id} and not exists(select 1 from inventory_reservation_lines l where l.reservation_id=r.id and l.reserved_base>l.consumed_base+l.released_base)`;
  }
  const balances =
    await c.db`select b.* from inventory_lot_balances b where b.lot_id in ${c.db(lotIds)} and b.stock_status='available' and b.physical_base>0 order by b.id limit 501 for update`;
  if (balances.length > 500)
    invalid("Split the recall: more than 500 stocked lot locations");
  for (const balance of balances)
    await postMovement(c.db, {
      ...common,
      kind: "status_change",
      idempotencyKey: `recall:${recallId}:hold:${balance.id}`,
      lines: [
        {
          productId: balance.product_id,
          lotId: balance.lot_id,
          fromLocationId: balance.location_id,
          toLocationId: balance.location_id,
          fromStockStatus: "available",
          toStockStatus: "quality_hold",
          uom: "base",
          quantityBase: Number(balance.physical_base),
        },
      ],
    });
  await c.db`update inventory_lots set quality_status='quarantined' where id in ${c.db(lotIds)} and quality_status not in ('expired','rejected')`;
  return {
    heldLots: lotIds.length,
    heldLocations: balances.length,
    releasedReservations: reserved.length,
  };
}
