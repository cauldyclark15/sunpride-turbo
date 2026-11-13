-- SP-0174: a phone that signed in but is not registered yet waits here, so the office can register a
-- person's FIRST phone from Setup > Phones without passing a code. The phone already proved the key at
-- sign-in (password + public key); registering still needs a scoped admin and the normal bind proof.
create table if not exists phone_registration_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  app text not null check (app in ('field-android','van-android')),
  key_id text not null,
  public_key_spki text not null,
  status text not null default 'waiting' check (status in ('waiting','registered','rejected','superseded')),
  requested_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  device_id uuid references registered_devices(id)
);
create unique index if not exists phone_registration_waiting_uq
  on phone_registration_requests(profile_id, app, key_id) where status = 'waiting';
create index if not exists phone_registration_waiting_idx
  on phone_registration_requests(status, last_seen_at desc);
