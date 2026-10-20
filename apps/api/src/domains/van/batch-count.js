import { integer, uuid, rows, refuse } from "./model.js";
import { productFor } from "./facts.js";

/** F-104 a physical batch count must be complete and must reconcile to its SKU/status count.
 * @param {any} db @param {any} trip @param {any[]} aggregate @param {any} input
 */
export async function validateBatchCount(db, trip, aggregate, input) {
  const actual =
    await db`select b.product_id,b.lot_id,b.stock_status,b.physical_base::text as quantity,l.lot_number,l.expires_at,l.quality_status from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.location_id=${trip.truck_location_id} and b.stock_status in ('available','damaged') order by b.product_id,b.lot_id,b.stock_status for update of b,l`;
  const supplied = actual.length ? rows(input, 2000) : [];
  if ((input?.length ?? 0) !== actual.length)
    refuse("Count every physical batch and quality status", "invalid_request");
  const seen = new Set(),
    postings = [];
  for (const l of supplied) {
    uuid(l.lotId);
    const key = `${l.lotId}:${l.status}`,
      a = actual.find(
        (/** @type {any} */ a) =>
          a.lot_id === l.lotId &&
          a.stock_status === l.status &&
          a.product_id === l.productId,
      );
    if (
      !a ||
      seen.has(key) ||
      integer(l.expectedBase) !== BigInt(a.quantity) ||
      l.batch !== a.lot_number ||
      l.expiresAt !==
        (a.expires_at ? new Date(a.expires_at).getTime() : null) ||
      l.qualityStatus !== a.quality_status
    )
      refuse("Batch stock changed or count is incomplete", "stock_conflict");
    seen.add(key);
    const delta = integer(l.countedBase) - BigInt(a.quantity);
    if (delta)
      postings.push({
        productId: l.productId,
        fromLocationId: delta < 0n ? trip.truck_location_id : null,
        toLocationId: delta > 0n ? trip.truck_location_id : null,
        stockStatus: l.status,
        quantityBase: Number(delta < 0n ? -delta : delta),
        lotId: l.lotId,
        uom: (await productFor(db, l.productId)).base_code,
      });
  }
  const tracked = new Set(actual.map((/** @type {any} */ a) => a.product_id));
  for (const line of aggregate.filter((l) => tracked.has(l.productId))) {
    const lots = supplied.filter(
      (l) => l.productId === line.productId && l.status === line.status,
    );
    if (
      lots.reduce((n, l) => n + integer(l.countedBase), 0n) !==
        integer(line.countedBase) ||
      lots.reduce((n, l) => n + integer(l.expectedBase), 0n) !==
        integer(line.expectedBase)
    )
      refuse(
        "Batch counts must reconcile with the product count",
        "stock_conflict",
      );
  }
  return { tracked, postings, lines: supplied };
}
