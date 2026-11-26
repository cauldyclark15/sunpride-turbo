-- SP-0244: unfinished phone enrollments are visible to the office, but are not outlets
-- or enrolments and cannot enter an approval queue. Closed rows prevent late retries
-- from resurrecting a submitted draft.
create table customer_enrollment_drafts (
  device_id uuid not null references registered_devices(id),
  draft_id uuid not null,
  actor_profile_id uuid not null references profiles(id),
  org_unit_id uuid not null references org_units(id),
  revision bigint not null,
  status text not null check (status in ('draft','discarded','submitted')),
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (device_id, draft_id)
);
create index customer_enrollment_drafts_open on customer_enrollment_drafts(updated_at desc, draft_id)
  where status='draft';
