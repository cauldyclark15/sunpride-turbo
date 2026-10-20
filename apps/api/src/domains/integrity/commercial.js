import { tx } from "@sunpride/db/client";

// SEAM(SAP): consume governed canonical replicas/events here; this adapter never posts money or stock.
// SEAM(FISCAL): retain the owner's discount/return/settlement revision provenance at integration.
// SEAM(VANOPS): adapt these read-only legacy return/settlement mappings to the owner's final event seam.
/** F-606: reads canonical domain tables, never writes another lane's ledger.
 * Bounded anti-join batches drain all sources; rejected/cancelled business records are excluded.
 * @param {any} db */
export async function collectCommercialSignals(db) {
  return tx(db, async (t) => {
    const orders =
      await t`select o.id,o.customer_code,o.outlet_id,o.total_centavos,o.updated_at,p.id as profile_id,p.org_unit_id,
      'order:'||o.id::text||':'||extract(epoch from o.updated_at)::text as source_key
      from orders o join profiles p on p.id=o.salesperson_profile_id where o.deleted_at is null and o.status not in ('draft','rejected','voided') and p.org_unit_id is not null and o.total_centavos is not null
      and not exists(select 1 from integrity_observations i where i.source_key='order:'||o.id::text||':'||extract(epoch from o.updated_at)::text)
      order by o.updated_at,o.id limit 200`;
    for (const r of orders)
      await t`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,outlet_id,occurred_at,facts)
      values (${r.source_key},'order',${r.profile_id},${r.org_unit_id},${r.outlet_id},${r.updated_at},${{ orderId: r.id, customerCode: r.customer_code, totalCentavos: String(r.total_centavos) }}) on conflict(source_key) do nothing`;
    const sales =
      await t`select s.*,v.salesperson_profile_id as profile_id,p.org_unit_id from van_sales s join van_trips v on v.id=s.trip_id join profiles p on p.id=v.salesperson_profile_id
      where p.org_unit_id is not null and s.discount_centavos>0 and not exists(select 1 from integrity_observations i where i.source_key='discount:'||s.id::text)
      order by s.created_at,s.id limit 200`;
    for (const r of sales)
      await t`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,outlet_id,occurred_at,facts)
      values (${`discount:${r.id}`},'discount',${r.profile_id},${r.org_unit_id},${r.outlet_id},${r.created_at},${{ saleId: r.id, tripId: r.trip_id, ratePct: (100 * Number(r.discount_centavos)) / Math.max(1, Number(r.total_centavos) + Number(r.discount_centavos)) }}) on conflict(source_key) do nothing`;
    const returns =
      await t`select r.*,v.salesperson_profile_id as profile_id,p.org_unit_id,
      (select coalesce(sum(quantity_base),0) from van_return_lines l where l.return_id=r.id) as returned,
      (select coalesce(sum(quantity_base),0) from van_sale_lines l where l.sale_id=r.sale_id) as sold
      from van_returns r join van_trips v on v.id=r.trip_id join profiles p on p.id=v.salesperson_profile_id
      where p.org_unit_id is not null and not exists(select 1 from integrity_observations i where i.source_key='return:'||r.id::text) order by r.created_at,r.id limit 200`;
    for (const r of returns)
      await t`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,occurred_at,facts)
      values (${`return:${r.id}`},'return',${r.profile_id},${r.org_unit_id},${r.created_at},${{ saleId: r.sale_id, tripId: r.trip_id, returnRatioPct: (Number(r.returned) * 100) / Math.max(1, Number(r.sold)), unlinked: !r.sale_id }}) on conflict(source_key) do nothing`;
    const counts =
      await t`select c.*,v.salesperson_profile_id as profile_id,p.org_unit_id from van_cash_counts c join van_trips v on v.id=c.trip_id join profiles p on p.id=v.salesperson_profile_id
      where p.org_unit_id is not null and not exists(select 1 from integrity_observations i where i.source_key='settlement:'||c.id::text) order by c.created_at,c.id limit 200`;
    for (const r of counts)
      await t`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,occurred_at,facts)
      values (${`settlement:${r.id}`},'settlement',${r.profile_id},${r.org_unit_id},${r.created_at},${{ tripId: r.trip_id, varianceCentavos: Number(r.variance_centavos) }}) on conflict(source_key) do nothing`;
    return {
      collected: orders.length + sales.length + returns.length + counts.length,
      hasMore: [orders, sales, returns, counts].some(
        (rows) => rows.length === 200,
      ),
    };
  });
}
