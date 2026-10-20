-- F-022 reviewed cutover staging extends the existing import run/receipt authority.
alter table import_runs drop constraint import_runs_import_type_check;
alter table import_runs add constraint import_runs_import_type_check check(import_type in ('products','opening_stock','stock_adjustment','cycle_count','mcp','customers','outlet_universe','route_master','open_ar'));
create table migration_staging_rows (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references import_runs(id),
  kind text not null check(kind in ('customers','outlet_universe','route_master','open_ar')),
  source_reference text not null,
  legacy_id text not null,
  sap_id text not null,
  row_number integer not null,
  payload jsonb not null,
  payload_hash text not null,
  status text not null default 'staged' check(status in ('staged','applied','mapped','rejected')),
  target_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(import_run_id,row_number)
);
create table migration_source_maps (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  source_reference text not null,
  legacy_id text not null,
  sap_id text not null,
  target_id uuid not null,
  staging_row_id uuid not null references migration_staging_rows(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(kind,source_reference,legacy_id),
  unique(kind,sap_id)
);
-- This is a read-only SAP-origin cutover projection, NOT a receivables ledger.
-- SEAM(SAP): ingestion will call the same projection adapter after cutover.
create table sap_open_ar_projection (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  sap_id text not null unique,
  document_number text not null,
  document_date date not null,
  due_date date not null,
  currency text not null check(currency='PHP'),
  original_centavos bigint not null check(original_centavos>=0),
  open_centavos bigint not null check(open_centavos>=0 and open_centavos<=original_centavos),
  source text not null default 'sap_cutover_projection',
  source_reference text not null,
  as_of date not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table migration_review_events (
  id uuid primary key default gen_random_uuid(),
  staging_row_id uuid not null references migration_staging_rows(id),
  action text not null check(action in ('create','map','reject')),
  actor_profile_id uuid not null references profiles(id),
  target_id uuid,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger migration_review_events_immutable before update or delete on migration_review_events for each row execute function masters_immutable();
-- F-011 original provider/fix instant/device retained alongside capture time.
alter table census_captures add column location_provider text;
alter table census_captures add column location_recorded_at timestamptz;
alter table census_captures add column device_id uuid references registered_devices(id);
