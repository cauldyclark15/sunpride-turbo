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
