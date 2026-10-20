-- F-311 F-313 F-314 F-315 F-316 F-320: effective retail masters and immutable field observations.
create table retail_master_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  kind text not null check (kind in ('planogram','posm','equipment','cold_policy','scorecard','expiry_policy','incident_category')),
  code text not null,
  version integer not null check(version>0),
  label text not null,
  outlet_class text not null default '*',
  effective_from timestamptz not null,
  effective_to timestamptz,
  data jsonb not null,
  source text not null check(source in ('sample','office','sap_replica')),
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,kind,code,version),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(organization_id with =,kind with =,code with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create index retail_master_current on retail_master_versions(kind,effective_from,effective_to);
-- F-313: individually issued POSM units. Stock valuation stays outside this register.
create table posm_custody_events (
  id uuid primary key default gen_random_uuid(),
  material_version_id uuid not null references retail_master_versions(id),
  unit_code text not null,
  kind text not null check(kind in ('issue','deploy','return','write_off_request','write_off')),
  outlet_id uuid references outlets(id),
  custodian_profile_id uuid not null references profiles(id),
  photo_id uuid references field_evidence_files(id),
  reason text not null,
  request_key uuid not null unique,
  actor_subject text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index posm_custody_unit on posm_custody_events(unit_code,occurred_at,id);
-- F-314: asset versions freeze serial/model/SAP fixed asset ID/agreement and deployment.
create table equipment_service_events (
  id uuid primary key default gen_random_uuid(),
  equipment_version_id uuid not null references retail_master_versions(id),
  kind text not null check(kind in ('service','repair','reconcile')),
  reference text not null,
  note text not null,
  actor_subject text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- F-310: these are domain facts consumed by the existing CALLFLOW engine, not a flow engine.
create table retail_execution_audits (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  visit_id uuid not null references visit_executions(id),
  outlet_id uuid not null references outlets(id),
  profile_id uuid not null references profiles(id),
  org_unit_id uuid not null references org_units(id),
  kind text not null check(kind in ('planogram','posm','freezer','competitor','promotion','expiry','issue_log')),
  request_key uuid not null unique,
  payload_hash text not null,
  master_version_id uuid references retail_master_versions(id),
  facts jsonb not null,
  component_score numeric check(component_score between 0 and 100),
  captured_at timestamptz not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index retail_audit_outlet on retail_execution_audits(outlet_id,captured_at,kind);
create index retail_audit_visit on retail_execution_audits(visit_id,kind);
-- F-315 F-320 F-321: operational queues, deliberately separate from QA issues.
create table retail_action_cases (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references retail_execution_audits(id),
  outlet_id uuid not null references outlets(id),
  kind text not null check(kind in ('cold_breach','pullout','markdown','incident')),
  status text not null default 'open' check(status in ('open','assigned','approved','awaiting_sap','resolved','rejected')),
  owner_profile_id uuid references profiles(id),
  due_at timestamptz not null,
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table retail_case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references retail_action_cases(id),
  kind text not null,
  note text not null,
  reference text,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- F-316: immutable weekly account publications include complete/missing component explanations.
create table perfect_store_publications (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  customer_id uuid not null references customers(id),
  scorecard_version_id uuid not null references retail_master_versions(id),
  revision integer not null,
  content_hash text not null,
  snapshot jsonb not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(week_start,customer_id,revision)
);
create table retail_commands (
  id uuid primary key default gen_random_uuid(),
  actor_subject text not null,
  request_key uuid not null,
  payload_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(actor_subject,request_key)
);
-- F-614: explicit delivered-batch confirmations supplement (never relabel) inferred allocations.
create table retail_batch_receipts (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  lot_id uuid not null references inventory_lots(id),
  quantity_base bigint not null check(quantity_base>0),
  source_key text not null unique,
  source_kind text not null check(source_kind in ('delivery_confirmation','sap_replica','sample')),
  source_version text not null,
  received_at timestamptz not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table retail_recall_cases (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references inventory_lots(id),
  reason text not null,
  status text not null default 'open' check(status in ('open','closed')),
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table retail_recall_events (
  id uuid primary key default gen_random_uuid(),
  recall_id uuid not null references retail_recall_cases(id),
  outlet_id uuid not null references outlets(id),
  kind text not null check(kind in ('notice','acknowledge','recovery','disposition')),
  quantity_base bigint not null default 0 check(quantity_base>=0),
  reference text not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Immutable evidence, custody, notices and publications. Guarded sample reset remains available.
create function retail_immutable() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' and current_setting('sunpride.seed_reset',true)='sunpride-demo-v2' and exists (
    select 1 from sample_data_rows where table_name=TG_TABLE_NAME and row_id=old.id::text
  ) then return old; end if;
  raise exception 'Retail execution history is immutable';
end $$;
do $$ declare tab text; begin
  foreach tab in array array['retail_execution_audits','posm_custody_events','equipment_service_events','retail_case_events','perfect_store_publications','retail_batch_receipts','retail_recall_events'] loop
    execute format('create trigger retail_append_only before update or delete on %I for each row execute function retail_immutable()',tab);
  end loop;
end $$;
