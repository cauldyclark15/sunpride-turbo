-- F-501 / F-503: one stable W3 campaign master, extended by W5 budgets.
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, code)
);
create table campaign_versions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  version integer not null check(version > 0),
  name text not null,
  mechanic text not null,
  status text not null check(status in ('draft','active','closed')),
  effective_from timestamptz not null,
  effective_to timestamptz not null,
  scope jsonb not null default '{}',
  checklist jsonb not null default '[]',
  budget_centavos bigint not null check(budget_centavos >= 0),
  expected_volume_base bigint not null check(expected_volume_base >= 0),
  expected_roi_bps integer not null check(expected_roi_bps >= 0),
  source text not null check(source in ('sample','office')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(campaign_id,version),
  check(effective_to > effective_from),
  exclude using gist(campaign_id with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
alter table promotions add column campaign_version_id uuid references campaign_versions(id);
alter table promotions add column engine_version integer not null default 1 check(engine_version = 1);
alter table promotions add column eligibility jsonb not null default '{}';
alter table promotions add column precedence integer not null default 100;
alter table promotions add column stacking text not null default 'exclusive' check(stacking in ('exclusive','stack'));
alter table promotions add column exclusion_group text;
alter table promotions add column excludes jsonb not null default '[]';
alter table promotions drop constraint promotions_rule_kind_check;
alter table promotions add constraint promotions_rule_kind_check check(rule_kind in
  ('buy_x_get_y','percent_off','bundle','slab','combo','bogo','free_goods','value_off','quantity_off','basket'));
create table campaign_commitments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  campaign_version_id uuid not null references campaign_versions(id),
  source_key text not null,
  amount_centavos bigint not null check(amount_centavos > 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(campaign_id,source_key)
);
create index campaign_versions_period on campaign_versions(status,effective_from,effective_to);
create table tpm_commands (
  id uuid primary key default gen_random_uuid(),
  actor_subject text not null,
  request_key text not null,
  payload_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(actor_subject,request_key)
);
