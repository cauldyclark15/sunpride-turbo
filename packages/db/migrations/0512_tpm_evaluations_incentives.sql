-- F-508/F-510 immutable directional evaluations and governed incentive snapshots.
create table promotion_evaluations (
 id uuid primary key default gen_random_uuid(), campaign_version_id uuid not null references campaign_versions(id),
 account_key text not null, mechanic text not null, source_key text not null unique,
 source_hash text not null, facts jsonb not null, result jsonb not null,
 created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table incentive_plans (
 id uuid primary key default gen_random_uuid(), code text not null, name text not null,
 effective_from timestamptz not null, effective_to timestamptz not null,
 base_centavos bigint not null check(base_centavos>=0), metrics jsonb not null,
 source text not null check(source in ('sample','office')),
 created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(effective_to>effective_from),
 exclude using gist(code with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create table incentive_statements (
 id uuid primary key default gen_random_uuid(), plan_id uuid not null references incentive_plans(id),
 profile_id uuid not null references profiles(id), period_from date not null, period_to date not null,
 source_key text not null, source_hash text not null, facts jsonb not null, result jsonb not null,
 amount_centavos bigint not null check(amount_centavos>=0),
 status text not null default 'calculated' check(status in ('calculated','approved','disputed')),
 created_by text not null, approved_by text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(period_to>=period_from), unique(plan_id,profile_id,period_from,period_to)
);
create table incentive_adjustments (
 id uuid primary key default gen_random_uuid(), statement_id uuid not null references incentive_statements(id),
 amount_centavos bigint not null, reason text not null, created_by text not null,
 approved_by text, status text not null default 'pending' check(status in ('pending','approved')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger promotion_evaluations_immutable before update or delete on promotion_evaluations for each row execute function tpm_immutable();
