-- Coverage-owned additions. Existing 01xx migrations remain immutable.
alter table coverage_plans add column signed_content jsonb;
create table coverage_commands (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references profiles(id),
  command_key text not null,
  payload_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(actor_id,command_key)
);
create unique index coverage_one_visit_per_slot on planned_visits(plan_slot_id);
create index coverage_slots_live_plan on coverage_plan_slots(plan_id) where deleted_at is null;
create table coverage_away_events (
  id uuid primary key default gen_random_uuid(),
  away_id uuid not null references supervisor_away_periods(id),
  profile_id uuid not null references profiles(id),
  actor_subject text not null,
  action text not null check(action in ('recorded','ended')),
  before jsonb not null,
  after jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

