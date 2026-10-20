-- F-009/F-010/F-012/F-013/F-014/F-017/F-305: authenticated command replay.
create table master_command_receipts (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references profiles(id),
  command text not null,
  request_key text not null,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(actor_profile_id,command,request_key)
);
