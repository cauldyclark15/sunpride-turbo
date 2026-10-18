-- 0001 platform (lane CORE). Domain tables live in 0100+ (lane SCHEMA) and must not redefine these.

-- The runner creates this before applying anything; repeated here so the file is self-describing.
create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create extension if not exists citext;
create extension if not exists vector;

-- Monotonic revision source for every phone-synced row and for the change log.
create sequence if not exists change_seq as bigint;
-- Realtime invalidation counter (NOTIFY payload `seq`).
create sequence if not exists event_seq as bigint;

-- Synced tables: `before update ... execute function bump_change_seq()`.
create or replace function bump_change_seq() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.change_seq := nextval('change_seq');
  return new;
end;
$$;

-- Non-synced tables with updated_at only.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz
);
create trigger users_touch before update on users for each row execute function touch_updated_at();

-- Opaque session credential; only its sha256 hex is stored.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  app text not null check (app in ('web', 'field-android', 'van-android', 'field-ios')),
  device_key_id text check (device_key_id is null or device_key_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz
);
create index sessions_user_id_idx on sessions (user_id);
create trigger sessions_touch before update on sessions for each row execute function touch_updated_at();

-- Native short-lived access credential (15 min), bound to a session.
create table access_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  session_id uuid not null references sessions(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index access_tokens_session_id_idx on access_tokens (session_id);
create index access_tokens_expires_at_idx on access_tokens (expires_at);

-- Admin-registered phone keys. profile_id has no FK: profiles arrive in lane SCHEMA.
create table registered_devices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  app text not null check (app in ('field-android', 'van-android', 'field-ios')),
  platform text not null check (platform in ('android', 'ios')),
  inventory_tag text not null,
  public_key_spki text not null,
  key_id text not null check (key_id ~ '^[0-9a-f]{64}$'),
  credential_id text,
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  bound_subject text,
  bound_at timestamptz,
  attestation jsonb,
  org_unit_id uuid,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((app = 'field-ios') = (platform = 'ios'))
);
create index registered_devices_profile_idx on registered_devices (profile_id, status);
create index registered_devices_key_idx on registered_devices (key_id, app);
create unique index registered_devices_credential_uq on registered_devices (credential_id) where credential_id is not null;
create unique index registered_devices_tag_uq on registered_devices (inventory_tag) where status <> 'revoked';
create unique index registered_devices_active_uq on registered_devices (profile_id, app) where status = 'active';
create trigger registered_devices_touch before update on registered_devices for each row execute function touch_updated_at();

create table device_challenges (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references registered_devices(id) on delete cascade,
  nonce uuid not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index device_challenges_device_idx on device_challenges (device_id, expires_at);

-- Fixed-window counters (challenge issuance per device, invalid-attempt budget per subject).
create table rate_limits (
  bucket_key text primary key,
  window_start timestamptz not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Per-operation idempotency receipts for /api/sync/push.
create table op_receipts (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  device_id uuid not null references registered_devices(id),
  client_op_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  op_type text not null,
  status text not null check (status in ('applied', 'rejected')),
  code text,
  ack jsonb,
  server_time timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject, device_id, client_op_id)
);

-- Append-only feed driving phone deltas; seq is the entity revision.
create table change_log (
  seq bigint primary key default nextval('change_seq'),
  entity text not null,
  entity_id text not null,
  scope_key text not null,
  op text not null check (op in ('upsert', 'tombstone')),
  at timestamptz not null default now()
);
create index change_log_scope_seq_idx on change_log (scope_key, seq);

-- Stored blobs. A claim reserves the row (status pending); the raw PUT stores it.
create table files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  purpose text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime text not null,
  size bigint not null check (size > 0),
  path text,
  status text not null default 'pending' check (status in ('pending', 'stored')),
  device_id uuid references registered_devices(id),
  upload_token_hash text,
  upload_expires_at timestamptz,
  stored_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index files_identity_uq on files (created_by, purpose, owner_id, sha256) nulls not distinct;
create unique index files_upload_token_uq on files (upload_token_hash) where upload_token_hash is not null;
create trigger files_touch before update on files for each row execute function touch_updated_at();

-- Durable deferred work. One pending row per (kind, coalesce_key).
create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  coalesce_key text,
  run_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index jobs_coalesce_pending_uq on jobs (kind, coalesce_key) where status = 'pending' and coalesce_key is not null;
create index jobs_due_idx on jobs (run_at) where status = 'pending';
create trigger jobs_touch before update on jobs for each row execute function touch_updated_at();

-- Vector store. No ANN index until a lane picks model/dims.
create table embeddings (
  id uuid primary key default gen_random_uuid(),
  owner_table text not null,
  owner_id uuid not null,
  model text not null,
  dims integer not null check (dims > 0),
  embedding vector not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (vector_dims(embedding) = dims)
);
create index embeddings_owner_idx on embeddings (owner_table, owner_id);
