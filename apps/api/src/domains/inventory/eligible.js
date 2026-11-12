// One rule for "stock that may leave to sell": used by posting (allocation) and by every screen that
// promises stock before posting (van load suggestions, the van day board). WEB-082/084: the board used
// to count every depot lot (quarantined, nearly expired) and promised loads approval then refused.
import { ORGANIZATION } from "./common.js";

/** The latest expiry a lot may have and still be refused (lots expiring on/before this are too close).
 * @param {any} policy @param {number} [at] */
export const shelfLifeCutoff = (policy, at = Date.now()) =>
  new Date(
    Math.max(at, Date.now()) +
      Number(policy?.minimum_remaining_shelf_life_days ?? 0) * 86400000,
  );

/** May this lot be issued for sale (released, not recall-held, far enough from expiry)?
 * @param {{quality_status:string, expires_at:any, recall_held?:boolean}} lot @param {any} policy @param {Date} cutoff */
export const lotSellable = (lot, policy, cutoff) =>
  !(
    lot.recall_held ||
    lot.quality_status !== "released" ||
    (lot.expires_at && new Date(lot.expires_at) <= cutoff) ||
    (Number(policy?.minimum_remaining_shelf_life_days) > 0 && !lot.expires_at)
  );

/** Free base quantity per product at a location that posting would actually allocate for a sale or
 * van load. Lot-tracked products count only sellable lots; untracked products use the balance.
 * @param {any} db @param {string} locationId @param {string[]} productIds @param {{org?:string, at?:number}} [o]
 * @returns {Promise<Map<string, number>>} */
export async function eligibleFreeBase(db, locationId, productIds, o = {}) {
  const org = o.org ?? ORGANIZATION;
  const ids = [...new Set(productIds)];
  /** @type {Map<string, number>} */ const out = new Map(ids.map((i) => [i, 0]));
  if (!ids.length || !locationId) return out;
  const products =
    await db`select p.id,coalesce(pol.tracking_mode,p.tracking_mode,'none') as tracking,pol.minimum_remaining_shelf_life_days
      from products p left join lateral (select * from product_inventory_policies x where x.product_id=p.id and x.organization_id=${org} and x.active and x.deleted_at is null limit 1) pol on true
      where p.id in ${db(ids)}`;
  const tracked = new Map();
  const untracked = [];
  for (const p of products)
    if (p.tracking === "none") untracked.push(p.id);
    else tracked.set(p.id, p);
  if (untracked.length)
    for (const r of await db`select product_id,available_base::bigint as q from inventory_balances where location_id=${locationId} and product_id in ${db(untracked)} and deleted_at is null`)
      out.set(r.product_id, Number(r.q));
  if (tracked.size) {
    const lots =
      await db`select b.product_id,b.available_base::bigint as q,l.expires_at,l.quality_status,
        exists(select 1 from inventory_lot_holds h where h.lot_id=l.id and h.released_at is null) as recall_held
        from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id
        where b.organization_id=${org} and b.location_id=${locationId} and b.product_id in ${db([...tracked.keys()])}
          and b.stock_status='available' and b.available_base>0`;
    for (const r of lots) {
      const policy = tracked.get(r.product_id);
      if (lotSellable(r, policy, shelfLifeCutoff(policy, o.at)))
        out.set(r.product_id, (out.get(r.product_id) ?? 0) + Number(r.q));
    }
  }
  return out;
}

/** Plain reason shown when a load asks for more than the sellable depot stock. */
export const DEPOT_SHORT_TEXT = "The depot does not have enough for some products";
