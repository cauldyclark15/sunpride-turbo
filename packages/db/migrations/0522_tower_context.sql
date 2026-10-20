-- F-604/F-606: UI read replicas only. PROGRAMME owns assets/score/incidents;
-- INTEGRITY owns findings, evidence, review and detector definitions.
create table analytics_outlet_context (
 id uuid primary key default gen_random_uuid(),outlet_id uuid not null references outlets(id),org_unit_id uuid not null references org_units(id),
 kind text not null check(kind in ('asset','issue','execution_score','class')),
 source_system text not null,source_key text not null,source_revision text not null,source_type text not null check(source_type in ('sample','replica')),
 effective_from timestamptz not null,effective_to timestamptz,payload jsonb not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(source_system,source_key,source_revision)
);
create index analytics_outlet_context_lookup on analytics_outlet_context(outlet_id,kind,effective_from);
create table analytics_integrity_findings (
 id uuid primary key default gen_random_uuid(),org_unit_id uuid not null references org_units(id),outlet_id uuid references outlets(id),profile_id uuid references profiles(id),
 source_system text not null,source_key text not null,source_revision text not null,source_type text not null check(source_type in ('sample','replica')),
 rule_code text not null,rule_version text not null,severity text not null check(severity in ('high','medium','low')),
 title text not null,detail text not null,status text not null check(status in ('open','reviewing','dismissed','confirmed')),
 occurred_at timestamptz not null,evidence jsonb not null,review_href text not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(source_system,source_key)
);
create index analytics_integrity_scope on analytics_integrity_findings(org_unit_id,occurred_at);
