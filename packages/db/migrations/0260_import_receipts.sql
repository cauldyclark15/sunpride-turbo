-- Persist the exact result for retry, plus a lane-owned append-only audit.
alter table import_runs add column result jsonb;
create table import_audit_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references import_runs(id),
  actor_profile_id uuid not null,
  actor_user_id uuid not null,
  action text not null,
  details jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index import_audit_events_run_idx on import_audit_events(run_id);
