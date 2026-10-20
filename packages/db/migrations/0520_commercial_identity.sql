-- F-601: source outlet is not the accounting account. Preserve the existing fact contract.
create or replace view analytics_sales_facts as
with people as materialized (select p.*,identity.subject from analytics_people p
 cross join lateral (select p.auth_subject as subject where p.auth_subject is not null
 union select p.user_id::text where p.user_id is not null) identity),
stores as materialized (select * from analytics_store_scope),
unique_accounts as materialized (select customer_code,min(id::text)::uuid id from stores
 where customer_code is not null group by customer_code having count(*)=1)
select o.id as order_id,l.id as line_id,o.status,o.created_at,
 coalesce(o.service_date,(coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date) as service_date,
 p.id as profile_id,p.name as agent_name,p.current_unit_id as agent_unit_id,
 loc.org_unit_id as source_unit_id,o.source_location_id,
 s.id as store_id,s.name as store_name,s.owner_unit_id,
 s.customer_id,o.customer_code,coalesce(s.channel,c.channel,'unassigned') as channel,
 s.territory_id,coalesce(s.territory_name,'Unassigned') as territory_name,
 pr.id as product_id,l.product_code,coalesce(pr.name,l.description) as product_name,
 coalesce(pr.category,'Uncategorised') as category,
 coalesce(l.line_total_centavos,round(l.line_total*100)::bigint) as sales_centavos,l.quantity,
 o.route_session_id,o.order_type,
 (o.status in ('approved','posted','fulfilled','sent_to_sap','partially_voided')) as approved,
 (o.status in ('posted','fulfilled','sent_to_sap')) as posted
from orders o join order_lines l on l.order_id=o.id
join people p on p.subject=o.salesperson_subject
left join customers c on c.code=o.customer_code and c.deleted_at is null
left join visit_activities activity on activity.id=o.source_activity_id
left join unique_accounts legacy on legacy.customer_code=o.customer_code
left join stores s on s.id=coalesce(o.outlet_id,activity.outlet_id,legacy.id)
left join inventory_locations loc on loc.id=o.source_location_id and loc.deleted_at is null
left join products pr on pr.id=l.product_id or (l.product_id is null and pr.code=l.product_code and pr.deleted_at is null)
where o.deleted_at is null and l.deleted_at is null and o.status not in ('draft','rejected','voided');

-- Existing cached assignments must never survive the definition change. Rebuilt lazily/jobs.
delete from analytics_refresh_state;

-- F-601: conformed source keys, effective attribution, separate CURRENT authorization keys.
-- Business amounts come from analytics_sales_facts, never a second sales computation.
create view analytics_commercial_facts as
select f.*,f.line_id as source_line_id,'orders'::text as source_system,
 coalesce(o.offline_created_at,o.created_at) as occurred_at,
 o.outlet_id as captured_outlet_id,
 case when o.outlet_id is not null then 'captured' when o.source_activity_id is not null then 'activity'
 when f.store_id is not null then 'unique_account_legacy' else 'unattributed' end as outlet_attribution,
 f.store_id as outlet_key,f.product_id as product_key,f.profile_id as rep_key,
 f.service_date as time_key,hist.territory_id as territory_key,rep.org_unit_id as rep_unit_at_event,
 hist.id as outlet_assignment_version,rep.id as rep_assignment_version,
 l.description as product_name_at_event,
 null::text as distributor_key,
 jsonb_build_object('order',o.id,'line',l.id,'orderRevision',o.change_seq,'lineRevision',l.change_seq,
 'definition','commercial/v1','source','operational_capture') as lineage
from analytics_sales_facts f join orders o on o.id=f.order_id join order_lines l on l.id=f.line_id
left join lateral(select a.id,a.territory_id from outlet_assignments a where a.outlet_id=f.store_id
 and a.deleted_at is null and a.effective_from<=coalesce(o.offline_created_at,o.created_at)
 and (a.effective_to is null or a.effective_to>coalesce(o.offline_created_at,o.created_at)) order by a.effective_from desc limit 1) hist on true
left join lateral(select a.id,a.org_unit_id from employee_assignments a where a.profile_id=f.profile_id
 and a.deleted_at is null and a.effective_from<=coalesce(o.offline_created_at,o.created_at)
 and (a.effective_to is null or a.effective_to>coalesce(o.offline_created_at,o.created_at)) order by a.effective_from desc limit 1) rep on true;

-- Six dimensions share keys with the commercial fact; time is Manila service date.
create view analytics_commercial_dimensions as
select 'outlet'::text kind,id::text key,name label,created_at effective_from,null::timestamptz effective_to from outlets where deleted_at is null
union all select 'product',id::text,name,created_at,null from products where deleted_at is null
union all select 'territory',id::text,name,effective_from,effective_to from territories where deleted_at is null
union all select 'rep',id::text,name,created_at,null from profiles where deleted_at is null
union all select 'time',service_date::text,service_date::text,service_date::timestamp at time zone 'Asia/Manila',(service_date+1)::timestamp at time zone 'Asia/Manila' from (select distinct service_date from analytics_sales_facts) d;
