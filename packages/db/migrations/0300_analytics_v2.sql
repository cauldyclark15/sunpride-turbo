-- Additive management read contract. Legacy numeric PHP amounts stay untouched.
alter table sales_targets drop constraint sales_targets_subject_kind_check;
alter table sales_targets add constraint sales_targets_subject_kind_check
  check (subject_kind in ('employee','team','territory','company','channel'));
alter table sales_targets add column month text check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
alter table sales_targets add column level text check (level in ('company','channel','territory','agent'));
alter table sales_targets add column target_key text;
alter table sales_targets add column amount_centavos bigint check (amount_centavos >= 0);
alter table sales_targets add column revision_at timestamptz not null default now();
create unique index analytics_targets_current on sales_targets(month,level,target_key)
  where level is not null and deleted_at is null;

-- Current scope always gates historical facts. Latest effective rows, never future projections.
create view analytics_people as
select p.*, coalesce(a.org_unit_id,p.org_unit_id) as current_unit_id,
 coalesce(a.position_id,p.position_id) as current_position_id, a.supervisor_id,
 coalesce(s.name, legacy.name) as supervisor_name,
 coalesce(s.id,legacy.id) as supervisor_profile_id
from profiles p
left join lateral (select * from employee_assignments a where a.profile_id=p.id
 and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
 order by effective_from desc limit 1) a on true
left join profiles s on s.id=a.supervisor_id and s.deleted_at is null
left join profiles legacy on legacy.auth_subject=p.supervisor_subject and legacy.deleted_at is null
where p.deleted_at is null;

create view analytics_store_scope as
select o.*, a.territory_id, t.name as territory_name,
 coalesce(own.org_unit_id,o.custodian_org_unit_id) as owner_unit_id,
 link.customer_id, c.code as customer_code, c.credit_limit, a.route_id,
 coalesce(a.cycle_days,o.visit_frequency_days) as cycle_days
from outlets o
left join lateral (select * from outlet_assignments a where a.outlet_id=o.id
 and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
 order by effective_from desc limit 1) a on true
left join territories t on t.id=a.territory_id
left join lateral (select * from territory_ownerships x where x.territory_id=a.territory_id
 and x.deleted_at is null and x.effective_from<=now() and (x.effective_to is null or x.effective_to>now())
 order by effective_from desc limit 1) own on true
left join lateral (select * from outlet_customer_links l where l.outlet_id=o.id
 and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now())
 order by effective_from desc limit 1) link on true
left join customers c on c.id=link.customer_id and c.deleted_at is null
where o.deleted_at is null;

-- One fact per source line. Shared accounting customers select one deterministic store;
-- they never multiply sales. Authorization ALSO checks stored creator and source location.
create view analytics_sales_facts as
with people as materialized (select p.*,identity.subject from analytics_people p
 cross join lateral (select p.auth_subject as subject where p.auth_subject is not null
 union select p.user_id::text where p.user_id is not null) identity),
stores as materialized (select distinct on (customer_code) s.* from analytics_store_scope s
 where customer_code is not null order by customer_code,s.id)
select o.id as order_id, l.id as line_id, o.status, o.created_at,
 (coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date as service_date,
 p.id as profile_id, p.name as agent_name, p.current_unit_id as agent_unit_id,
 loc.org_unit_id as source_unit_id, o.source_location_id,
 s.id as store_id, s.name as store_name, s.owner_unit_id,
 s.customer_id, o.customer_code, coalesce(s.channel,c.channel,'unassigned') as channel,
 s.territory_id, coalesce(s.territory_name,'Unassigned') as territory_name,
 pr.id as product_id, l.product_code, coalesce(pr.name,l.description) as product_name,
 coalesce(pr.category,'Uncategorised') as category,
 round(l.line_total*100)::bigint as sales_centavos, l.quantity,
 o.route_session_id, o.order_type,
 (o.status in ('approved','posted','fulfilled','sent_to_sap','partially_voided')) as approved,
 (o.status in ('posted','fulfilled','sent_to_sap')) as posted
from orders o join order_lines l on l.order_id=o.id
join people p on p.subject=o.salesperson_subject
left join customers c on c.code=o.customer_code and c.deleted_at is null
left join stores s on s.customer_code=o.customer_code
left join inventory_locations loc on loc.id=o.source_location_id and loc.deleted_at is null
left join products pr on pr.code=l.product_code and pr.deleted_at is null
where o.deleted_at is null and l.deleted_at is null and o.status not in ('draft','rejected','voided');

create index analytics_orders_service_date on orders (((coalesce(offline_created_at,created_at) at time zone 'Asia/Manila')::date));
create index analytics_visit_day on visit_executions(service_date,assignee_profile_id) where deleted_at is null;
create index analytics_planned_day on planned_visits(service_date,assignee_profile_id) where deleted_at is null;
create index analytics_store_customer on outlet_customer_links(customer_id,effective_from) where deleted_at is null;

-- Daily materialization keeps full dimensions, so totals and drill-down use one definition.
create table analytics_daily_sales (
 id uuid primary key default gen_random_uuid(), service_date date not null,
 profile_id uuid not null references profiles(id), store_id uuid, product_id uuid,
 channel text not null, territory_id uuid, category text not null,
 org_unit_id uuid, sales_centavos bigint not null, booked bigint not null,
 approved bigint not null, posted bigint not null, quantity numeric not null,
 order_ids uuid[] not null, customer_codes text[] not null, line_count integer not null,
 computed_at timestamptz not null default now(),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index analytics_daily_sales_day on analytics_daily_sales(service_date,profile_id);
create table analytics_refresh_state (
 service_date date primary key, computed_at timestamptz not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
