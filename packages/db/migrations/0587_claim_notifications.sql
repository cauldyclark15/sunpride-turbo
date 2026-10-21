-- F-507/F-608: free local mail sink, configured provider receipts, governed follow-up.
alter table claim_types add column escalation_hours integer not null default 48 check(escalation_hours between 1 and 720);
alter table claim_types add column email_notifications boolean not null default true;
create table notification_email_deliveries (
 id uuid primary key default gen_random_uuid(),
 message_key text not null unique,
 recipient text not null,
 subject text not null,
 body text not null,
 provider text not null check(provider in ('dev_sink','resend')),
 state text not null check(state in ('dev_sink','accepted','expired')),
 provider_id text,
 created_at timestamptz not null default now()
);
create table claim_escalations (
 id uuid primary key default gen_random_uuid(),
 claim_id uuid not null references claims(id),
 profile_id uuid not null references profiles(id),
 source_version text not null,
 approval_rule_id uuid not null references claim_approval_rules(id),
 message text not null,
 read_at timestamptz,
 created_at timestamptz not null default now(),
 unique(claim_id,profile_id,source_version,approval_rule_id)
);
create index claim_escalation_recipient on claim_escalations(profile_id,created_at desc);
