-- IP-NAV: one Decide inbox for every approval. Every decision made there is kept with the rule that sent it there.
-- The decisions themselves are made by the owning document's own command (the server enforces maker is not checker there);
-- this table is the inbox's own record, and the whole record for the kinds that have no document verb (override review,
-- "send back" of a transfer difference).
create table decide_log (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  kind text not null,
  ref_id text not null,
  verdict text not null check (verdict in ('approved', 'rejected')),
  reason text not null,
  rule text,
  document_number text,
  value_centavos bigint,
  actor_user_id text not null,
  actor_profile_id uuid not null references profiles(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (kind, ref_id, idempotency_key)
);
create index decide_log_ref_idx on decide_log (kind, ref_id, created_at desc);
create index decide_log_recent_idx on decide_log (created_at desc);
