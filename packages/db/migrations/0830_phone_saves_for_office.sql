-- SP-0188: phone saves are never lost.
-- 1. A field-app customer that is incomplete is kept as a draft; the agent's submitted values and
--    the missing fields are stored so the office can finish it in the same CDM review.
-- 2. Every operation the server must permanently refuse is copied here before the phone is told,
--    so the office can see it and the phone can let go of it ("kept": true in the push result).
-- Additive only: the previous API version keeps working while this runs.
alter table customer_profiles add column if not exists field_missing jsonb;
alter table customer_profiles add column if not exists field_submitted jsonb;

create table if not exists op_refusals (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  profile_id uuid,
  device_id uuid not null references registered_devices(id),
  app text not null,
  -- The op's clientOpId; a malformed op without one is keyed by a hash of what was sent.
  client_op_id text not null,
  op_type text,
  code text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  note text,
  unique (subject, device_id, client_op_id)
);
create index if not exists op_refusals_open_idx on op_refusals (created_at desc) where resolved_at is null;
