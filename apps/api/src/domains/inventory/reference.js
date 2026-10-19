import { requireCapability } from "../../core/capabilities.js";
import {
  blindStockGate,
  id,
  number,
  ORGANIZATION,
  visibleLocations,
} from "./common.js";
import { presenter } from "./units.js";

/** Lot facts are revealed only through scoped stock partitions, never the global lot master.
 * @param {any} ctx
 */
export async function lots(ctx) {
  const locations = await visibleLocations(ctx),
    ids = locations.map((l) => l.id);
  if (!ids.length) return [];
  await blindStockGate(ctx, ids);
  const product = ctx.url.searchParams.get("productId"),
    lotId = ctx.url.searchParams.get("lotId");
  if (product) id(product);
  if (lotId) id(lotId);
  const rows =
    await ctx.db`select b.*,l.lot_number,l.expires_at,l.quality_status from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.organization_id=${ORGANIZATION} and b.location_id in ${ctx.db(ids)} order by l.expires_at,b.id`;
  const result = [];
  for (const r of rows) {
    if ((product && product !== r.product_id) || (lotId && lotId !== r.lot_id))
      continue;
    const p = await presenter(ctx.db, r.product_id, ctx.now);
    result.push({
      id: r.id,
      lotId: r.lot_id,
      productId: r.product_id,
      code: p.product.code,
      name: p.product.name,
      lotNumber: r.lot_number,
      locationId: r.location_id,
      locationName: locations.find((l) => l.id === r.location_id)?.name,
      stockStatus: r.stock_status,
      qualityStatus: r.quality_status,
      expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
      onHand: p.quantity(r.physical_base),
      reserved: p.quantity(r.reserved_base),
      available: p.quantity(r.available_base),
      version: r.version,
    });
  }
  return result;
}
/** @param {any} ctx */
export async function policies(ctx) {
  await requireCapability(ctx, "inventory.read");
  const rows =
    await ctx.db`select * from product_inventory_policies where organization_id=${ORGANIZATION} and active and deleted_at is null order by product_id`;
  const result = [];
  for (const r of rows) {
    const p = await presenter(ctx.db, r.product_id, ctx.now);
    result.push({
      id: r.id,
      productId: r.product_id,
      code: p.product.code,
      name: p.product.name,
      trackingMode: r.tracking_mode,
      allocationPolicy: r.allocation_policy,
      qualityReleaseRequired: r.quality_release_required,
      expiryDateRequired: r.expiry_date_required,
      manufactureDateRequired: r.manufacture_date_required,
      minimumRemainingShelfLifeDays: number(
        r.minimum_remaining_shelf_life_days,
      ),
      version: r.version,
    });
  }
  return result;
}
