-- F-201/F-202/F-224: permanent journey plans extend signed monthly coverage.
create table outlet_class_visit_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  org_unit_id uuid not null references org_units(id),
  class_key text not null,
  label text not null,
  interval_weeks integer not null check (interval_weeks in (1,2,4)),
  service_minutes integer not null check (service_minutes between 1 and 480),
  objectives text[] not null default '{}',
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_ref text not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  exclude using gist (org_unit_id with =, class_key with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create table pjp_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  org_unit_id uuid not null references org_units(id),
  assignee_profile_id uuid not null references profiles(id),
  name text not null,
  version integer not null,
  anchor_date date not null,
  effective_from timestamptz not null,
  effective_to timestamptz not null,
  capacity_minutes integer not null check (capacity_minutes between 1 and 1440),
  travel_minutes integer not null check (travel_minutes between 0 and 240),
  selling_weekdays smallint[] not null,
  stops jsonb not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to > effective_from),
  unique(assignee_profile_id,version)
);
create table pjp_simulations (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references pjp_templates(id),
  local_month text not null,
  input_hash text not null,
  result jsonb not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table coverage_plans add column pjp_source jsonb;
create table pjp_publications (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references pjp_templates(id),
  simulation_id uuid not null unique references pjp_simulations(id),
  plan_id uuid not null unique references coverage_plans(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table pjp_events (
  id uuid primary key default gen_random_uuid(),
  org_unit_id uuid not null references org_units(id),
  actor_id uuid not null references profiles(id),
  kind text not null,
  entity_id uuid not null,
  detail jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pjp_templates_scope_idx on pjp_templates(org_unit_id,assignee_profile_id);
create index pjp_policy_lookup_idx on outlet_class_visit_policies(org_unit_id,class_key,effective_from);
