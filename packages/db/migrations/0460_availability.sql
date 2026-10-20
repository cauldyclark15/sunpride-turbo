-- F-211–F-220: retail execution. MASTERS owns taxonomy and the MSL framework;
-- releases below freeze its versioned assignment policy, not a second product master.
create table availability_releases (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('msl','focus','launch','rules')),
  policy_key text not null,
  version integer not null check (version > 0),
  label text not null,
  status text not null check (status in ('draft','published')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  source_ref text not null,
  sample boolean not null default false,
  actor_subject text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(kind,policy_key,version),
  check (effective_to is null or effective_to > effective_from),
  exclude using gist (kind with =, policy_key with =, tstzrange(effective_from,effective_to,'[)') with &&) where (status='published')
);
create index availability_releases_effective_idx on availability_releases(kind,status,effective_from);

-- Frozen outlet/MSL/objective/suggestion projection, retained for offline replay.
create table availability_call_snapshots (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  profile_id uuid not null references profiles(id),
  app text not null check (app in ('web','field-android','van-android')),
  service_date date not null,
  content_hash text not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(outlet_id,profile_id,app,service_date,content_hash)
);
create index availability_call_snapshots_day_idx on availability_call_snapshots(profile_id,service_date);

-- Explicit not_checked rows remain in the denominator. A completed check cannot omit one.
create table availability_checks (
  id uuid primary key,
  snapshot_id uuid not null references availability_call_snapshots(id),
  outlet_id uuid not null references outlets(id),
  profile_id uuid not null references profiles(id),
  org_unit_id uuid not null references org_units(id),
  visit_id uuid references visit_executions(id),
  trip_id uuid references van_trips(id),
  call_key uuid not null,
  service_date date not null,
  device_time timestamptz not null,
  complete boolean not null,
  required_count integer not null check (required_count > 0),
  checked_count integer not null,
  present_count integer not null,
  lines jsonb not null,
  proposals jsonb not null,
  payload_hash text not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (checked_count between 0 and required_count),
  check (present_count between 0 and checked_count),
  check (not complete or checked_count=required_count),
  check ((visit_id is not null) <> (trip_id is not null))
);
create index availability_checks_outlet_date_idx on availability_checks(outlet_id,service_date,device_time desc);
create index availability_checks_call_idx on availability_checks(profile_id,call_key);

-- Seller decisions are separate from shelf evidence; absence never posts an order.
create table availability_proposal_decisions (
  id uuid primary key,
  check_id uuid not null references availability_checks(id),
  product_id uuid not null references products(id),
  decision text not null check (decision in ('accepted','dismissed')),
  quantity_base bigint not null check (quantity_base >= 0),
  order_key uuid,
  actor_subject text not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(check_id,product_id),
  check ((decision='accepted' and quantity_base>0 and order_key is not null) or (decision='dismissed' and quantity_base=0))
);

-- One validated cohort, frozen with explicit turnover weights and provenance.
create table availability_universes (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  service_date date not null,
  members jsonb not null check (jsonb_typeof(members)='array'),
  source_ref text not null,
  sample boolean not null default false,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index availability_universes_date_idx on availability_universes(service_date desc,created_at desc);

create function availability_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('sunpride.sample_reset',true)='on' and tg_op='DELETE' then
    if exists(select 1 from sample_data_rows where table_name=tg_table_name and row_id=old.id::text) then return old; end if;
  end if;
  raise exception 'Retail evidence is immutable';
end $$;
create trigger availability_checks_immutable before update or delete on availability_checks for each row execute function availability_immutable();
create trigger availability_snapshots_immutable before update or delete on availability_call_snapshots for each row execute function availability_immutable();
create trigger availability_decisions_immutable before update or delete on availability_proposal_decisions for each row execute function availability_immutable();
create trigger availability_universes_immutable before update or delete on availability_universes for each row execute function availability_immutable();
