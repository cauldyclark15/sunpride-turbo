-- FINISH-B governed measurement inputs and versioned AI execution history.
-- Sample values remain labelled; neither a model nor ROI writes financial transactions.
create table promotion_performance_policies (
 id uuid primary key default gen_random_uuid(), campaign_version_id uuid not null references campaign_versions(id),
 distributor_id uuid not null references distributors(id), product_id uuid not null references products(id),
 account_key text not null, revision integer not null check(revision>0),
 unit_margin_centavos bigint not null check(unit_margin_centavos>=0), other_cost_centavos bigint not null check(other_cost_centavos>=0),
 margin_reference text not null, cost_reference text not null, source text not null check(source in ('sample','operational')),
 created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(campaign_version_id,account_key,product_id,revision)
);
create trigger promotion_performance_policy_immutable before update or delete on promotion_performance_policies for each row execute function tpm_immutable();
create table analytics_model_versions (
 id uuid primary key default gen_random_uuid(), purpose text not null check(purpose in ('shelf','suggested_order')),
 version integer not null check(version>0), org_unit_id uuid not null references org_units(id),
 algorithm text not null, configuration jsonb not null, artifact jsonb not null, metrics jsonb not null,
 source_hash text not null, status text not null check(status in ('candidate','approved','retired')),
 sample boolean not null default true, created_by text not null, approved_by text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_unit_id,purpose,version)
);
create table analytics_model_runs (
 id uuid primary key default gen_random_uuid(), model_id uuid references analytics_model_versions(id),
 org_unit_id uuid not null references org_units(id), outlet_id uuid references outlets(id),
 purpose text not null check(purpose in ('shelf','suggested_order')), source_reference text not null,
 request_key text not null, source_hash text not null, input jsonb not null, result jsonb not null,
 status text not null check(status in ('predicted','unavailable','reviewed','corrected')),
 created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(created_by,request_key)
);
create table analytics_model_reviews (
 id uuid primary key default gen_random_uuid(), run_id uuid not null references analytics_model_runs(id),
 decision text not null check(decision in ('accepted','corrected','rejected')), correction jsonb,
 reason text not null, reviewed_by text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger analytics_model_review_immutable before update or delete on analytics_model_reviews for each row execute function tpm_immutable();
