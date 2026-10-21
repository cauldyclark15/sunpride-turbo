-- F-007: a human-readable, expiring replacement code; the candidate key remains server-side.
create table device_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  app text not null check (app in ('field-android','van-android')),
  key_id text not null,
  public_key_spki text not null,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);
create index device_pairing_profile_idx on device_pairing_requests(profile_id,key_id,created_at desc);

