-- Incrementally refreshed source-line projection. Current authorization is NEVER cached.
create table analytics_sales_cache as select f.*, now() as computed_at,now() as updated_at from analytics_sales_facts f with no data;
alter table analytics_sales_cache add primary key(line_id);
alter table analytics_sales_cache add column source_order_seq bigint not null;
alter table analytics_sales_cache add column source_line_seq bigint not null;
create index analytics_sales_cache_date on analytics_sales_cache(service_date,profile_id);
create view analytics_cached_facts as
with people as materialized(select p.*,identity.subject from analytics_people p
 cross join lateral(select p.auth_subject as subject where p.auth_subject is not null union select p.user_id::text where p.user_id is not null) identity),
stores as materialized(select * from analytics_store_scope)
select c.order_id,c.line_id,o.status,c.created_at,c.service_date,
 p.id as profile_id,p.name as agent_name,p.current_unit_id as agent_unit_id,
 loc.org_unit_id as source_unit_id,o.source_location_id,
 s.id as store_id,s.name as store_name,s.owner_unit_id,s.customer_id,c.customer_code,
 coalesce(s.channel,c.channel) as channel,s.territory_id,coalesce(s.territory_name,'Unassigned') as territory_name,
 c.product_id,c.product_code,c.product_name,c.category,c.sales_centavos,c.quantity,
 o.route_session_id,o.order_type,c.approved,c.posted
from analytics_sales_cache c join orders o on o.id=c.order_id and o.deleted_at is null
join people p on p.subject=o.salesperson_subject
join order_lines l on l.id=c.line_id and l.deleted_at is null
 and c.source_line_seq=l.change_seq and c.source_order_seq=o.change_seq
left join stores s on s.id=c.store_id
left join inventory_locations loc on loc.id=o.source_location_id and loc.deleted_at is null
where o.status not in ('draft','rejected','voided');
