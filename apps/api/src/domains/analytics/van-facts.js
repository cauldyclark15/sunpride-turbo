// Read-only bridge from canonical handheld documents. No second sale/order/payment writer.
// Scope is applied to the captured trip, seller, truck AND current store owner by callers.
export const VAN_SALES_SQL = `(with van_people as materialized(select * from analytics_people),
  van_stores as materialized(select * from analytics_store_scope)
  select t.service_date,pe.id profile_id,pe.name agent_name,pe.current_unit_id agent_unit_id,
  loc.org_unit_id source_unit_id,t.truck_location_id source_location_id,
  o.id store_id,o.name store_name,o.owner_unit_id,s.customer_code,o.channel,
  o.territory_id,o.territory_name,l.product_id,l.facts->>'name' product_name,
  coalesce(pr.category,'Uncategorised') category,l.total_centavos sales_centavos,
  true approved,false posted,s.id order_id,l.quantity_base::numeric / nullif((l.facts->>'quantityScale')::numeric,0) quantity,
  t.org_unit_id van_unit_id
  from van_sales s join van_trips t on t.id=s.trip_id
  join van_sale_lines l on l.sale_id=s.id join van_people pe on pe.id=t.salesperson_profile_id
  join van_stores o on o.id=s.outlet_id
  join inventory_locations loc on loc.id=t.truck_location_id and loc.deleted_at is null
  join products pr on pr.id=l.product_id
  where t.deleted_at is null and t.status<>'cancelled'
  and not exists(select 1 from van_sale_voids v where v.sale_id=s.id))`;

export const SALES_COLUMNS = `service_date,profile_id,agent_name,agent_unit_id,source_unit_id,source_location_id,
  store_id,store_name,owner_unit_id,customer_code,channel,territory_id,territory_name,product_id,product_name,
  category,sales_centavos,approved,posted,order_id,quantity`;

/** Payments actually collected, not credit promises or cash handed from seller to cashier a second time.
 * @param {any} db @param {any} p @param {any} s */
export async function readVanCollections(db, p, s) {
  const ids = s.ids.length ? s.ids : [null];
  return db`with people as materialized(select id,current_unit_id from analytics_people),
    stores as materialized(select id,owner_unit_id,channel,customer_id from analytics_store_scope)
    select v.id,v.trip_id,sa.outlet_id,sa.customer_code,o.customer_id,t.salesperson_profile_id assignee_profile_id,
      v.method,v.created_at device_time,
      case when v.kind in ('refund','void_refund') then -v.amount_centavos else v.amount_centavos end amount_minor
    from van_payments v join van_trips t on t.id=v.trip_id join van_sales sa on sa.id=v.sale_id
    join people pe on pe.id=t.salesperson_profile_id join stores o on o.id=sa.outlet_id
    join inventory_locations loc on loc.id=t.truck_location_id and loc.deleted_at is null
    where t.deleted_at is null and t.status<>'cancelled' and v.method<>'credit'
    and t.service_date between ${p.from} and ${p.to}
    and t.org_unit_id in ${db(ids)} and pe.current_unit_id in ${db(ids)} and o.owner_unit_id in ${db(ids)} and loc.org_unit_id in ${db(ids)}
    and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) and (${p.channel}::text is null or o.channel=${p.channel})`;
}

/** Unposted van credit is an operational receivable, separate from the office aging feed.
 * Native collections settle these exact invoices, never unrelated office debt.
 * @param {any} db @param {any} p @param {any} s */
export async function readVanCredit(db, p, s) {
  const ids = s.ids.length ? s.ids : [null];
  return db`with people as materialized(select id,name,current_unit_id from analytics_people),
    stores as materialized(select id,owner_unit_id,channel,customer_id,name,credit_limit from analytics_store_scope)
    select sa.id,sa.customer_code,o.customer_id,o.name,o.channel,o.credit_limit,pe.name agent_name,
      sa.receipt->'payment'->>'dueDate' due_date,
      greatest(0,sa.total_centavos-coalesce(c.paid,0))::text balance,c.last_payment
    from van_sales sa join van_trips t on t.id=sa.trip_id
    join people pe on pe.id=t.salesperson_profile_id join stores o on o.id=sa.outlet_id
    join inventory_locations loc on loc.id=t.truck_location_id and loc.deleted_at is null
    left join lateral(select sum(amount_centavos) paid,max(created_at) last_payment from van_payments
      where sale_id=sa.id and kind='collection' and (created_at at time zone 'Asia/Manila')::date<=${p.to}) c on true
    where sa.receipt->'payment'->>'kind'='credit' and t.service_date<=${p.to} and t.deleted_at is null and t.status<>'cancelled'
    and not exists(select 1 from van_sale_voids v where v.sale_id=sa.id)
    and t.org_unit_id in ${db(ids)} and pe.current_unit_id in ${db(ids)} and o.owner_unit_id in ${db(ids)} and loc.org_unit_id in ${db(ids)}
    and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) and (${p.channel}::text is null or o.channel=${p.channel})`;
}
