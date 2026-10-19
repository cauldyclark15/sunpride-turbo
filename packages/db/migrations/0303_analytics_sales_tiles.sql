-- Compact daily grouping tiles; current master/source revisions gate every use.
alter table analytics_refresh_state add column masters_fingerprint text;
create function analytics_master_fingerprint() returns text language sql stable as $$
 select concat_ws(':',
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from profiles),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from employee_assignments),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from outlets),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from outlet_assignments),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from outlet_customer_links),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from territory_ownerships),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from territories),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from products),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from inventory_locations))
$$;
create table analytics_sales_tiles (
 id uuid primary key default gen_random_uuid(),service_date date not null,
 group_kind text not null,group_key text not null,label text not null,
 profile_id uuid not null,agent_unit_id uuid,owner_unit_id uuid,source_unit_id uuid,
 source_location_id uuid,channel text not null,territory_id uuid,
 sales bigint not null,approved bigint not null,posted bigint not null,
 orders integer not null,lines integer not null,quantity numeric not null,
 buyers text[] not null,stores uuid[] not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index analytics_sales_tiles_read on analytics_sales_tiles(group_kind,service_date,agent_unit_id);
