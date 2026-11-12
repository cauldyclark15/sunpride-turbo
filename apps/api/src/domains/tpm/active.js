import { fail } from "../orders/validation.js";

/** F-502: shared governed scheme catalog. Orders retain their compatibility export;
 * native projections and van capture do not depend on an order-price adapter.
 * @param {any} db @param {string} organizationId @param {number} at */
export async function activePromotions(db, organizationId, at) {
  const rows = await db`select p.*,v.scope as campaign_scope,
    (v.source='sample' or exists(select 1 from sample_data_rows sd where sd.table_name='promotions' and sd.row_id=p.id::text)) as planning_sample from promotions p
    left join campaign_versions v on v.id=p.campaign_version_id
    where p.organization_id=${organizationId} and p.deleted_at is null and p.status='active'
    and p.effective_from<=${new Date(at)} and (p.effective_to is null or p.effective_to>${new Date(at)})
    and (v.id is null or (v.status='active' and v.effective_from<=${new Date(at)} and v.effective_to>${new Date(at)}))
    order by p.precedence,p.code limit 501`;
  if (rows.length > 500)
    fail("More than 500 active schemes; narrow the catalog");
  return rows;
}

/** FLD-116: a promotion pinned to a governed price list (e.g. SMP-SUPERMARKET) must
 * also match lines priced from that list's SAP condition mirror ("SAP-<code>", created by
 * condition ingestion), because SAP is the price authority (F-016) and every quoted line
 * carries the mirror's id. Re-points only when a line's list is exactly that mirror; other
 * promotions are returned unchanged, so no list gains or loses a promotion otherwise.
 * @param {any} db @param {any[]} promotions @param {(string|null|undefined)[]} priceListIds */
export async function alignPromotionPriceLists(db, promotions, priceListIds) {
  const lineLists = [...new Set(priceListIds.filter(Boolean))];
  const pinned = [
    ...new Set(
      promotions
        .map((p) => p.price_list_id)
        .filter((id) => id && !lineLists.includes(id)),
    ),
  ];
  if (!lineLists.length || !pinned.length) return promotions;
  const pairs =
    await db`select g.id as governed_id,m.id as mirror_id from price_lists g
    join price_lists m on m.organization_id=g.organization_id and m.code='SAP-'||g.code and m.source='sap' and m.deleted_at is null
    where g.id in ${db(pinned)} and m.id in ${db(lineLists)} and g.deleted_at is null`;
  const mirror = new Map(
    pairs.map((/** @type {any} */ r) => [r.governed_id, r.mirror_id]),
  );
  return promotions.map((p) =>
    mirror.has(p.price_list_id)
      ? { ...p, price_list_id: mirror.get(p.price_list_id) }
      : p,
  );
}
