-- F-602 governance: effective policy, not hidden hard-coded business thresholds.
create table analytics_cockpit_policies (
 id uuid primary key default gen_random_uuid(),org_unit_id uuid not null references org_units(id),
 freshness_days integer not null check(freshness_days between 1 and 90),
 effective_from timestamptz not null,effective_to timestamptz,
 source_ref text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(effective_to is null or effective_to>effective_from),
 exclude using gist(org_unit_id with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create table analytics_turnover_weights (
 id uuid primary key default gen_random_uuid(),outlet_id uuid not null references outlets(id),
 turnover_centavos bigint not null check(turnover_centavos>=0),effective_from timestamptz not null,effective_to timestamptz,
 source_ref text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 exclude using gist(outlet_id with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
-- F-603/F-607 read-only commercial replicas, NOT distributor/SAP transaction tables.
-- SEAM(DISTRIBUTOR/SAP/PROGRAMME): adapters supply source keys and revisioned facts here.
create table analytics_trade_inputs (
 id uuid primary key default gen_random_uuid(),kind text not null check(kind in ('primary','secondary','stock','promotion_plan')),
 source_system text not null,source_key text not null,source_revision text not null,source_received_at timestamptz not null,
 source_effective_at timestamptz not null,source_type text not null check(source_type in ('sample','replica')),
 org_unit_id uuid not null references org_units(id),distributor_key text not null,distributor_name text not null,
 outlet_id uuid references outlets(id),product_id uuid not null references products(id),
 service_date date not null,quantity_base bigint not null,amount_centavos bigint,
 campaign_ref text,channel text,account_name text,lineage jsonb not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(source_system,kind,source_key),check(kind<>'secondary' or outlet_id is not null)
);
create index analytics_trade_period on analytics_trade_inputs(service_date,org_unit_id,kind);
create index analytics_trade_outlet on analytics_trade_inputs(outlet_id,service_date);
create or replace view analytics_commercial_dimensions as
select 'outlet'::text kind,id::text key,name label,created_at effective_from,null::timestamptz effective_to from outlets where deleted_at is null
union all select 'product',id::text,name,created_at,null from products where deleted_at is null
union all select 'territory',id::text,name,effective_from,effective_to from territories where deleted_at is null
union all select 'rep',id::text,name,created_at,null from profiles where deleted_at is null
union all select 'time',service_date::text,service_date::text,service_date::timestamp at time zone 'Asia/Manila',(service_date+1)::timestamp at time zone 'Asia/Manila' from (select distinct service_date from analytics_sales_facts union select service_date from analytics_trade_inputs) d
union all select 'distributor',distributor_key,max(distributor_name),min(source_effective_at),null from analytics_trade_inputs group by distributor_key;

-- F-607 frozen, versioned handoff with source-line lineage and explicit acceptance.
create table demand_signal_snapshots (
 id uuid primary key default gen_random_uuid(),org_unit_id uuid references org_units(id),created_by uuid not null references profiles(id),
 period_from date not null,period_to date not null,cutoff_at timestamptz not null,definition_version text not null,
 request_key text not null,request_hash text not null,content_hash text not null,payload jsonb not null,
 status text not null check(status in ('prepared','published','accepted','rejected')),
 destination text,published_at timestamptz,acknowledged_at timestamptz,acknowledged_by uuid references profiles(id),
 acknowledgement text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(created_by,request_key)
);
-- F-609/F-610 preparation only. No model inference and no synthetic quality claims.
create table analytics_ai_dataset_items (
 id uuid primary key default gen_random_uuid(),purpose text not null check(purpose in ('shelf_ground_truth','order_backtest')),
 org_unit_id uuid not null references org_units(id),outlet_id uuid references outlets(id),product_id uuid references products(id),
 source_reference text not null,observed_at timestamptz not null,consent_reference text not null,retain_until timestamptz not null,
 annotations jsonb not null,split text not null check(split in ('train','validation','temporal_holdout')),
 source_type text not null check(source_type in ('sample','real')),created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
