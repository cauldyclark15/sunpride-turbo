-- SP-0249: office requests are retained until the exact phone acknowledges them.
alter table phone_registration_requests drop constraint phone_registration_requests_app_check;
alter table phone_registration_requests add constraint phone_registration_requests_app_check check (app in ('field-android','van-android','field-ios'));
alter table profiles add column phone_office_auto_accept boolean not null default false;
create table phone_commands (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  device_id uuid references registered_devices(id),
  app text not null check (app in ('field-android','van-android','field-ios')),
  key_id text not null check (key_id ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('sign_out','refresh','resend','remove','update')),
  requested_by text not null,
  download_url text,
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  completed_at timestamptz
);
create index phone_commands_pending on phone_commands(profile_id,app,key_id,created_at) where completed_at is null;
-- Terminal commands belong to the sessions ended by that request, never a later sign-in.
create table phone_command_sessions (
  command_id uuid not null references phone_commands(id),
  session_id uuid not null references sessions(id) on delete cascade,
  primary key(command_id,session_id)
);
create table phone_checkins (
  profile_id uuid not null references profiles(id),
  app text not null,
  key_id text not null,
  checked_at timestamptz not null default now(),
  unsent_count integer not null check (unsent_count between 0 and 1000000),
  app_version text,
  model text,
  primary key(profile_id,app,key_id)
);
