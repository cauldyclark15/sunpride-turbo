import { integer, uuid, refuse, rows } from "./model.js";

/** F-104 exact physical batch allocations; never let a later server FEFO guess replace offline evidence.
 * @param {any} db @param {any} trip @param {any} product @param {any} line @param {number} at
 */
export async function saleLots(db, trip, product, line, at) {
  const [policy] =
    await db`select tracking_mode,minimum_remaining_shelf_life_days from product_inventory_policies where product_id=${product.id} and active and deleted_at is null`;
  if (!policy || policy.tracking_mode === "none") {
    if (line.allocations?.length)
      refuse("Untracked product cannot use a batch", "invalid_request");
    return [];
  }
  const input = rows(line.allocations, 50),
    seen = new Set();
  let total = 0n;
  const result = [];
  for (const allocation of input) {
    const lotId = uuid(allocation.lotId),
      qty = integer(allocation.quantityBase, true);
    if (seen.has(lotId)) refuse("Batch allocation repeated", "invalid_request");
    seen.add(lotId);
    const [lot] =
      await db`select l.*,b.available_base from inventory_lots l join inventory_lot_balances b on b.lot_id=l.id where l.id=${lotId} and l.product_id=${product.id} and b.location_id=${trip.truck_location_id} and b.stock_status='available' for update of l,b`;
    if (
      !lot ||
      BigInt(lot.available_base) < qty ||
      lot.quality_status !== "released" ||
      (lot.expires_at &&
        new Date(lot.expires_at).getTime() <=
          at + Number(policy.minimum_remaining_shelf_life_days ?? 0) * 86400000)
    )
      refuse("Batch is unavailable, expired or held", "stock_conflict");
    if (
      allocation.batch !== lot.lot_number ||
      allocation.expiresAt !==
        (lot.expires_at ? new Date(lot.expires_at).getTime() : null) ||
      allocation.qualityStatus !== lot.quality_status
    )
      refuse("Batch facts changed; refresh before selling", "stock_conflict");
    result.push({
      lotId,
      batch: lot.lot_number,
      expiresAt: allocation.expiresAt,
      qualityStatus: lot.quality_status,
      quantityBase: String(qty),
    });
    total += qty;
  }
  if (total !== integer(line.quantityBase, true))
    refuse("Batch quantities must match the sale line", "invalid_request");
  return result;
}

/** @param {any} db @param {any} trip */
export async function lotBundle(db, trip) {
  const lots =
    await db`select b.product_id as "productId",b.lot_id as "lotId",l.lot_number as batch,l.expires_at as expiry,l.quality_status as "qualityStatus",b.stock_status as status,b.available_base::text as "quantityBase" from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.location_id=${trip.truck_location_id} order by b.expiry_sort_key,b.receipt_sequence,b.id limit 2001`;
  if (lots.length > 2000)
    refuse("Truck batch stock exceeds the offline bound", "invalid_request");
  const loadLots =
    await db`select ll.line_number as "lineNumber",ll.product_id as "productId",ll.lot_id as "lotId",l.lot_number as batch,l.expires_at as expiry,l.quality_status as "qualityStatus" from van_trip_load_lines ll join inventory_lots l on l.id=ll.lot_id where ll.trip_id=${trip.id} order by ll.line_number limit 501`;
  if (loadLots.length > 500)
    refuse("Load batches exceed the offline bound", "invalid_request");
  const map = (/** @type {any} */ l) => {
    const { expiry, ...rest } = l;
    return { ...rest, expiresAt: expiry ? new Date(expiry).getTime() : null };
  };
  const trackedProducts =
    await db`select p.product_id as "productId",p.minimum_remaining_shelf_life_days as "shelfLifeDays" from product_inventory_policies p where p.active and p.deleted_at is null and p.tracking_mode<>'none' and p.product_id in (select product_id from van_trip_load_lines where trip_id=${trip.id})`;
  return { lots: lots.map(map), loadLots: loadLots.map(map), trackedProducts };
}
