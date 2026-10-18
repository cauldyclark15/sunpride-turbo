-- 0115_imports: CSV/XLSX import runs.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: import_runs, import_run_locations, import_run_errors.

-- importRuns
create table import_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  import_type text not null check (import_type in ('products', 'opening_stock', 'stock_adjustment', 'cycle_count', 'mcp')),
  mcp_plan_id uuid,
  run_key text not null,
  chunk_index integer not null,
  file_hash text not null,
  chunk_hash text,
  idempotency_key text not null,
  actor_subject text not null,
  status text not null check (status in ('previewed', 'committing', 'completed', 'failed', 'submitted')),
  source_reference text,
  row_keys text[] default '{}' not null,
  adjustment_type text,
  reason_code text,
  adjustment_id uuid,
  session_id uuid,
  row_count integer not null,
  file_row_count integer,
  created_count integer not null,
  updated_count integer not null,
  skipped_count integer not null,
  failed_count integer not null,
  movement_id uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index import_runs_organization_id_and_idempotency_key_key on import_runs (organization_id, idempotency_key);
create index import_runs_organization_id_and_run_key_idx on import_runs (organization_id, run_key);
create index import_runs_organization_id_and_type_and_file_hash_idx on import_runs (organization_id, import_type, file_hash);
create index import_runs_organization_id_and_created_at_idx on import_runs (organization_id, created_at);
create trigger import_runs_set_updated_at before update on import_runs for each row execute function set_updated_at();

-- importRuns (importRuns.locationIds[])
create table import_run_locations (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null,
  ordinal integer not null,
  location_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index import_run_locations_parent_ordinal_key on import_run_locations (import_run_id, ordinal);
create trigger import_run_locations_set_updated_at before update on import_run_locations for each row execute function set_updated_at();

-- importRunErrors
create table import_run_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  run_id uuid not null,
  row_number integer not null,
  column_name text,
  code text not null,
  message text not null,
  raw_row text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index import_run_errors_organization_id_and_run_id_and_row_number_idx on import_run_errors (organization_id, run_id, row_number);
create trigger import_run_errors_set_updated_at before update on import_run_errors for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table import_runs add constraint import_runs_mcp_plan_id_fkey foreign key (mcp_plan_id) references coverage_plans(id);
alter table import_runs add constraint import_runs_adjustment_id_fkey foreign key (adjustment_id) references inventory_adjustments(id);
alter table import_runs add constraint import_runs_session_id_fkey foreign key (session_id) references stock_count_sessions(id);
alter table import_runs add constraint import_runs_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table import_run_locations add constraint import_run_locations_import_run_id_fkey foreign key (import_run_id) references import_runs(id) on delete cascade;
alter table import_run_locations add constraint import_run_locations_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table import_run_errors add constraint import_run_errors_run_id_fkey foreign key (run_id) references import_runs(id);

-- Supporting indexes for foreign keys without a leading index.
create index import_runs_mcp_plan_id_fk_idx on import_runs (mcp_plan_id);
create index import_runs_adjustment_id_fk_idx on import_runs (adjustment_id);
create index import_runs_session_id_fk_idx on import_runs (session_id);
create index import_runs_movement_id_fk_idx on import_runs (movement_id);
create index import_run_locations_location_id_fk_idx on import_run_locations (location_id);
create index import_run_errors_run_id_fk_idx on import_run_errors (run_id);
