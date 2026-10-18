-- 0114_analytics: Daily rollups, agent metrics, targets, admin pack.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: daily_territory_metrics, daily_customer_metrics, daily_sku_metrics, rollup_contributions, rollup_contribution_skus, rollup_refreshes, agent_daily_metrics, agent_metric_refreshes, suggested_order_promotions, admin_pack_records, sales_targets.

-- dailyTerritoryMetrics
create table daily_territory_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  service_date date not null,
  org_unit_id uuid not null,
  territory_id uuid not null,
  planned_calls integer not null,
  planned_calls_done integer not null,
  visits integer not null,
  completed_visits integer not null,
  unplanned_visits integer not null,
  calls integer not null,
  productive_calls integer not null,
  collections integer not null,
  collections_minor bigint not null,
  orders integer not null,
  sales_minor bigint not null,
  return_orders integer not null,
  returns_minor bigint not null,
  buying_customers integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index daily_territory_metrics_territory_id_and_service_date_key on daily_territory_metrics (territory_id, service_date);
create index daily_territory_metrics_organization_id_and_service_date_idx on daily_territory_metrics (organization_id, service_date);
create index daily_territory_metrics_org_unit_id_and_service_date_idx on daily_territory_metrics (org_unit_id, service_date);
create trigger daily_territory_metrics_set_updated_at before update on daily_territory_metrics for each row execute function set_updated_at();

-- dailyCustomerMetrics
create table daily_customer_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  service_date date not null,
  org_unit_id uuid not null,
  customer_code text not null,
  customer_id uuid,
  territory_id uuid,
  planned_calls integer not null,
  planned_calls_done integer not null,
  visits integer not null,
  completed_visits integer not null,
  unplanned_visits integer not null,
  calls integer not null,
  productive_calls integer not null,
  collections integer not null,
  collections_minor bigint not null,
  orders integer not null,
  sales_minor bigint not null,
  return_orders integer not null,
  returns_minor bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index daily_customer_metrics_customer_code_and_service_date_idx on daily_customer_metrics (customer_code, service_date);
create index daily_customer_metrics_organization_id_and_service_date_idx on daily_customer_metrics (organization_id, service_date);
create index daily_customer_metrics_org_unit_id_and_service_date_idx on daily_customer_metrics (org_unit_id, service_date);
create index daily_customer_metrics_territory_id_and_service_date_idx on daily_customer_metrics (territory_id, service_date);
create unique index daily_customer_metrics_unit_customer_date_key on daily_customer_metrics (org_unit_id, customer_code, service_date);
create trigger daily_customer_metrics_set_updated_at before update on daily_customer_metrics for each row execute function set_updated_at();

-- dailySkuMetrics
create table daily_sku_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  service_date date not null,
  org_unit_id uuid not null,
  product_code text not null,
  orders integer not null,
  quantity numeric(14,3) not null,
  sales_minor bigint not null,
  return_orders integer not null,
  return_quantity numeric(14,3) not null,
  returns_minor bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index daily_sku_metrics_product_code_and_service_date_idx on daily_sku_metrics (product_code, service_date);
create index daily_sku_metrics_organization_id_and_service_date_idx on daily_sku_metrics (organization_id, service_date);
create index daily_sku_metrics_org_unit_id_and_service_date_idx on daily_sku_metrics (org_unit_id, service_date);
create unique index daily_sku_metrics_unit_product_date_key on daily_sku_metrics (org_unit_id, product_code, service_date);
create trigger daily_sku_metrics_set_updated_at before update on daily_sku_metrics for each row execute function set_updated_at();

-- rollupContributions
create table rollup_contributions (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('order', 'visit', 'planned')),
  source_id text not null,
  service_date date not null,
  org_unit_id uuid not null,
  territory_id uuid,
  customer_code text,
  customer_id uuid,
  metrics_planned_calls integer not null,
  metrics_planned_calls_done integer not null,
  metrics_visits integer not null,
  metrics_completed_visits integer not null,
  metrics_unplanned_visits integer not null,
  metrics_calls integer not null,
  metrics_productive_calls integer not null,
  metrics_collections integer not null,
  metrics_collections_minor bigint not null,
  metrics_orders integer not null,
  metrics_sales_minor bigint not null,
  metrics_return_orders integer not null,
  metrics_returns_minor bigint not null,
  complete boolean not null,
  version text not null,
  computed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index rollup_contributions_source_kind_and_source_id_key on rollup_contributions (source_kind, source_id);
create trigger rollup_contributions_set_updated_at before update on rollup_contributions for each row execute function set_updated_at();

-- rollupContributions (rollupContributions.skus[])
create table rollup_contribution_skus (
  id uuid primary key default gen_random_uuid(),
  rollup_contribution_id uuid not null,
  ordinal integer not null,
  product_code text not null,
  orders integer not null,
  quantity numeric(14,3) not null,
  sales_minor bigint not null,
  return_orders integer not null,
  return_quantity numeric(14,3) not null,
  returns_minor bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index rollup_contribution_skus_parent_ordinal_key on rollup_contribution_skus (rollup_contribution_id, ordinal);
create trigger rollup_contribution_skus_set_updated_at before update on rollup_contribution_skus for each row execute function set_updated_at();

-- rollupRefreshes
create table rollup_refreshes (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('order', 'visit', 'planned')),
  source_id text not null,
  requested_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index rollup_refreshes_source_kind_and_source_id_key on rollup_refreshes (source_kind, source_id);
create trigger rollup_refreshes_set_updated_at before update on rollup_refreshes for each row execute function set_updated_at();

-- agentDailyMetrics [synced]
create table agent_daily_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  profile_id uuid not null,
  service_date date not null,
  local_month text not null check (local_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  org_unit_id uuid,
  position_id uuid,
  planned_calls integer not null,
  calls integer not null,
  productive_calls integer not null,
  nonproductive_calls integer not null,
  productive_pct double precision,
  planned_not_visited integer not null,
  visits integer not null,
  unplanned_visits integer not null,
  open_visits integer not null,
  skipped_visits integer not null,
  late_sync_visits integer not null,
  visits_missing_activities integer not null,
  call_duration_ms bigint not null,
  timed_visits integer not null,
  first_start_at timestamptz,
  last_end_at timestamptz,
  orders integer not null,
  return_orders integer not null,
  buying_accounts integer not null,
  sales_value numeric(14,2) not null,
  collections integer not null,
  collections_pending_review integer not null,
  collections_value numeric(14,2) not null,
  daily_calls_target integer,
  productive_call_target_pct double precision,
  complete boolean not null,
  rule_version text not null,
  metrics_version text not null,
  computed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index agent_daily_metrics_profile_id_and_service_date_key on agent_daily_metrics (profile_id, service_date);
create index agent_daily_metrics_organization_id_and_service_date_idx on agent_daily_metrics (organization_id, service_date);
create index agent_daily_metrics_org_unit_id_and_service_date_idx on agent_daily_metrics (org_unit_id, service_date);
create index agent_daily_metrics_change_seq_idx on agent_daily_metrics (change_seq);
create trigger agent_daily_metrics_bump_change_seq before update on agent_daily_metrics for each row execute function bump_change_seq();

-- agentMetricRefreshes
create table agent_metric_refreshes (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  service_date date not null,
  requested_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agent_metric_refreshes_profile_id_and_service_date_key on agent_metric_refreshes (profile_id, service_date);
create trigger agent_metric_refreshes_set_updated_at before update on agent_metric_refreshes for each row execute function set_updated_at();

-- suggestedOrderPromotions [synced]
create table suggested_order_promotions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid not null,
  program_ref text not null,
  uplift_pct double precision not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_ref text not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint suggested_order_promotions_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint suggested_order_promotions_no_overlap exclude using gist (organization_id with =, product_id with =, program_ref with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index suggested_order_promotions_organization_id_and_product_b3300595 on suggested_order_promotions (organization_id, product_id, effective_from);
create index suggested_order_promotions_change_seq_idx on suggested_order_promotions (change_seq);
create trigger suggested_order_promotions_bump_change_seq before update on suggested_order_promotions for each row execute function bump_change_seq();

-- adminPackRecords
create table admin_pack_records (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  period text not null,
  source text not null check (source in ('sample', 'office')),
  code text not null,
  kind text not null check (kind in ('program_allocation', 'priority_document', 'adp_claim', 'ar_balance')),
  details jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index admin_pack_records_organization_id_and_kind_and_period_idx on admin_pack_records (organization_id, kind, period);
create unique index admin_pack_records_organization_id_and_code_key on admin_pack_records (organization_id, code);
create index admin_pack_records_organization_id_and_source_idx on admin_pack_records (organization_id, source);
create trigger admin_pack_records_set_updated_at before update on admin_pack_records for each row execute function set_updated_at();

-- salesTargets [synced]
create table sales_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  subject_kind text not null check (subject_kind in ('employee', 'team', 'territory')),
  profile_id uuid,
  team_id uuid,
  territory_id uuid,
  period text not null check (period in ('daily', 'monthly')),
  metric text not null check (metric in ('sales_value', 'calls', 'productive_calls')),
  value numeric(14,2) not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_ref text not null,
  notes text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint sales_targets_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint sales_targets_no_overlap exclude using gist ((coalesce(profile_id, team_id, territory_id)) with =, subject_kind with =, period with =, metric with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index sales_targets_profile_id_and_period_and_metric_and_eff_abbb0cdd on sales_targets (profile_id, period, metric, effective_from);
create index sales_targets_team_id_and_period_and_metric_and_effect_82274ef7 on sales_targets (team_id, period, metric, effective_from);
create index sales_targets_territory_id_and_period_and_metric_and_e_be4db527 on sales_targets (territory_id, period, metric, effective_from);
create index sales_targets_organization_id_and_effective_from_idx on sales_targets (organization_id, effective_from);
create index sales_targets_change_seq_idx on sales_targets (change_seq);
create trigger sales_targets_bump_change_seq before update on sales_targets for each row execute function bump_change_seq();

-- Foreign keys (added after every table in this file exists).
alter table daily_territory_metrics add constraint daily_territory_metrics_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table daily_territory_metrics add constraint daily_territory_metrics_territory_id_fkey foreign key (territory_id) references territories(id);
alter table daily_customer_metrics add constraint daily_customer_metrics_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table daily_customer_metrics add constraint daily_customer_metrics_customer_id_fkey foreign key (customer_id) references customers(id);
alter table daily_customer_metrics add constraint daily_customer_metrics_territory_id_fkey foreign key (territory_id) references territories(id);
alter table daily_sku_metrics add constraint daily_sku_metrics_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table rollup_contributions add constraint rollup_contributions_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table rollup_contributions add constraint rollup_contributions_territory_id_fkey foreign key (territory_id) references territories(id);
alter table rollup_contributions add constraint rollup_contributions_customer_id_fkey foreign key (customer_id) references customers(id);
alter table rollup_contribution_skus add constraint rollup_contribution_skus_rollup_contribution_id_fkey foreign key (rollup_contribution_id) references rollup_contributions(id) on delete cascade;
alter table agent_daily_metrics add constraint agent_daily_metrics_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table agent_daily_metrics add constraint agent_daily_metrics_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table agent_daily_metrics add constraint agent_daily_metrics_position_id_fkey foreign key (position_id) references positions(id);
alter table agent_metric_refreshes add constraint agent_metric_refreshes_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table suggested_order_promotions add constraint suggested_order_promotions_product_id_fkey foreign key (product_id) references products(id);
alter table admin_pack_records add constraint admin_pack_records_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table sales_targets add constraint sales_targets_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table sales_targets add constraint sales_targets_team_id_fkey foreign key (team_id) references teams(id);
alter table sales_targets add constraint sales_targets_territory_id_fkey foreign key (territory_id) references territories(id);

-- Supporting indexes for foreign keys without a leading index.
create index daily_customer_metrics_customer_id_fk_idx on daily_customer_metrics (customer_id);
create index rollup_contributions_org_unit_id_fk_idx on rollup_contributions (org_unit_id);
create index rollup_contributions_territory_id_fk_idx on rollup_contributions (territory_id);
create index rollup_contributions_customer_id_fk_idx on rollup_contributions (customer_id);
create index agent_daily_metrics_position_id_fk_idx on agent_daily_metrics (position_id);
create index suggested_order_promotions_product_id_fk_idx on suggested_order_promotions (product_id);
create index admin_pack_records_org_unit_id_fk_idx on admin_pack_records (org_unit_id);
