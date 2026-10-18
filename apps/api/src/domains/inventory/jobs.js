import { tx } from "@sunpride/db/client";
import { enqueue } from "../../core/jobs.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import { manilaDate, stockLock } from "./common.js";
import { postMovement } from "./posting.js";

/** Bounded, resumable expiry batches. Reserved stock is released first through the
 * same writer, so a hard reservation cannot keep expired goods sellable.
 * @param {any} db @param {number} [now]
 */
export async function expireLots(db, now = Date.now()) {
  const result = await tx(db, async (t) => {
    const rows =
      await t`select b.*,l.organization_id,l.product_id from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where l.expires_at<=${new Date(now)} and b.stock_status in ('available','quality_hold','quarantine') and b.physical_base>0 order by l.expires_at,b.id limit 20`;
    let processed = 0;
    const units = new Set();
    for (const candidate of rows) {
      await stockLock(t, candidate.organization_id);
      const [b] =
        await t`select b.*,l.expires_at from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.id=${candidate.id} for update of b,l`;
      if (
        !b ||
        Number(b.physical_base) <= 0 ||
        new Date(b.expires_at).getTime() > now
      )
        continue;
      const [loc] =
        await t`select * from inventory_locations where id=${b.location_id}`;
      const base = {
        organizationId: b.organization_id,
        occurredAt: now,
        actor: { profileId: null, userId: null },
        sourceType: "expiry_job",
        sourceId: b.lot_id,
      };
      if (Number(b.reserved_base) > 0) {
        await postMovement(t, {
          ...base,
          kind: "reservation_release",
          idempotencyKey: `expire-release:${b.id}:${b.version}`,
          lines: [
            {
              productId: b.product_id,
              quantityBase: Number(b.reserved_base),
              uom: "base",
              fromLocationId: b.location_id,
              toLocationId: null,
              lotId: b.lot_id,
            },
          ],
        });
        await t`update inventory_reservation_lines set released_base=reserved_base-consumed_base where organization_id=${b.organization_id} and lot_id=${b.lot_id} and location_id=${b.location_id} and reserved_base>consumed_base+released_base`;
        await t`update inventory_reservations r set status='expired' where r.organization_id=${b.organization_id} and r.status in ('active','partially_consumed') and exists (select 1 from inventory_reservation_lines l where l.reservation_id=r.id and l.lot_id=${b.lot_id}) and not exists (select 1 from inventory_reservation_lines l where l.reservation_id=r.id and l.reserved_base>l.consumed_base+l.released_base)`;
      }
      await postMovement(t, {
        ...base,
        kind: "status_change",
        idempotencyKey: `expire:${b.id}:${b.version}`,
        lines: [
          {
            productId: b.product_id,
            quantityBase: Number(b.physical_base),
            uom: "base",
            fromLocationId: b.location_id,
            toLocationId: b.location_id,
            lotId: b.lot_id,
            fromStockStatus: b.stock_status,
            toStockStatus: "expired",
          },
        ],
      });
      await t`update inventory_lots set quality_status='expired' where id=${b.lot_id}`;
      units.add(loc?.org_unit_id ?? null);
      processed++;
    }
    const [more] =
      await t`select 1 from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where l.expires_at<=${new Date(now)} and b.stock_status in ('available','quality_hold','quarantine') and b.physical_base>0 limit 1`;
    if (more)
      await enqueue(t, {
        kind: "inventory.expire-lots",
        key: "continue",
        payload: {},
      });
    return { processed, more: Boolean(more), units: [...units] };
  });
  return result;
}
/** @param {any} core */
export function installJobs(core) {
  /** @param {{db:any}} ctx */
  const run = async ({ db }) => {
    const result = await expireLots(db);
    if (result.processed) {
      await core.publish("inventory");
      for (const unitId of result.units)
        await enqueueRefresh(
          { db, publish: core.publish },
          { kind: "stock", date: manilaDate(), unitId },
        );
    }
  };
  core.registerJob("inventory.expire-lots", run);
  core.scheduler.daily("00:15", "Asia/Manila", "inventory.expire-lots", run);
}
