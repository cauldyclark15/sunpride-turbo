-- SP-0227: authorized print facts and explicit POS trip membership.
-- Existing quantity-only records remain readable but are not certified requests.
alter table truck_weeks add column request_facts jsonb;
alter table truck_weeks add column closed_report jsonb;
create table truck_week_trips (
  week_id uuid not null references truck_weeks(id),
  trip_id uuid not null unique references van_trips(id),
  primary key (week_id, trip_id)
);
create table truck_week_report_events (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references truck_weeks(id),
  actor_profile_id uuid not null references profiles(id),
  kind text not null check (kind in ('request_saved','counted','reviewed')),
  facts jsonb not null,
  created_at timestamptz not null default now()
);
