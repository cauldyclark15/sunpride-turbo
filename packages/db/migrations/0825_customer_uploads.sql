-- 0825_customer_uploads: SP-0170 customer upload (machinery from SP-0169; renumbered after the 0820-0824 customer master migrations).
-- One run per uploaded file; every row's outcome is persisted as its chunk commits, so an
-- interrupted run reports exactly which rows succeeded, failed or were not processed, and a
-- resume processes only the rows still pending. A lease/heartbeat marks a dead worker.

create table customer_upload_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  file_name text not null,
  file_hash text not null,
  row_count integer not null check (row_count between 1 and 5000),
  chunk_size integer not null check (chunk_size between 1 and 1000),
  status text not null check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'interrupted')),
  succeeded_count integer not null default 0,
  failed_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  actor_user_id text not null,
  -- Who the worker acts as: the starter, or whoever last resumed or retried the run.
  acting_user_id text not null,
  actor_profile_id uuid not null,
  actor_name text,
  actor_org_unit_id uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  interrupted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customer_upload_runs_org_created_idx on customer_upload_runs (organization_id, created_at desc, id desc);
create index customer_upload_runs_org_hash_idx on customer_upload_runs (organization_id, file_hash);
-- The same file can be queued or running only once at a time.
create unique index customer_upload_runs_live_file_key on customer_upload_runs (organization_id, file_hash)
  where status in ('queued', 'running');
create trigger customer_upload_runs_set_updated_at before update on customer_upload_runs
  for each row execute function set_updated_at();

create table customer_upload_chunks (
  run_id uuid not null references customer_upload_runs(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  chunk_hash text not null,
  row_count integer not null,
  attempts integer not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, chunk_index)
);
create trigger customer_upload_chunks_set_updated_at before update on customer_upload_chunks
  for each row execute function set_updated_at();

create table customer_upload_rows (
  run_id uuid not null references customer_upload_runs(id) on delete cascade,
  row_number integer not null check (row_number >= 2),
  chunk_index integer not null,
  customer_code text not null,
  cells jsonb not null,
  action text check (action in ('new', 'update')),
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  errors jsonb not null default '[]',
  outlet_id uuid references outlets(id),
  attempts integer not null default 0,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, row_number),
  foreign key (run_id, chunk_index) references customer_upload_chunks(run_id, chunk_index) on delete cascade
);
create index customer_upload_rows_chunk_status_idx on customer_upload_rows (run_id, chunk_index, status);
create index customer_upload_rows_outlet_idx on customer_upload_rows (outlet_id) where outlet_id is not null;
create trigger customer_upload_rows_set_updated_at before update on customer_upload_rows
  for each row execute function set_updated_at();

-- ROLLBACK (manual):
--   drop table customer_upload_rows; drop table customer_upload_chunks; drop table customer_upload_runs;
--   delete from schema_migrations where name = '0825_customer_uploads.sql';
