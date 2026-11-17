-- SP-0185: admin password reset (temporary password, forced change) and self-service forgot password.
-- Additive only: the previous API version keeps working while this runs (new columns have defaults,
-- new tables are unused by it).
alter table users add column if not exists must_change_password boolean not null default false;
alter table users add column if not exists temp_password_expires_at timestamptz;

-- Reset links. Only the sha256 hex of the token is stored; the token itself lives only in the email.
create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists password_reset_tokens_user_idx on password_reset_tokens (user_id);

-- Sign-in emails sent (reset links, temporary passwords): who, what kind, provider receipt and state.
-- Never the message body, the link, the token or the password.
create table if not exists auth_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  recipient text not null,
  kind text not null check (kind in ('reset_link', 'temporary_password')),
  provider text not null,
  provider_id text,
  state text not null check (state in ('dev_sink', 'accepted', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists auth_email_deliveries_created_idx on auth_email_deliveries (created_at);
