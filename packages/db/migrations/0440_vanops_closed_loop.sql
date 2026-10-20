-- F-105/F-114/F-115/F-116/F-117/F-118/F-121/F-123 additive route-sales evidence.
alter table van_trips add column end_odometer_km double precision;
alter table van_trips add column locally_completed_at timestamptz;
alter table van_trips add column operations_version integer not null default 0 check(operations_version in (0,1));

-- Each replacement is a new effective-dated version. No implicit fallback to an arbitrary version.
create table van_policy_versions (
  id uuid primary key default gen_random_uuid(),
  org_unit_id uuid not null references org_units(id),
  kind text not null check(kind in ('cold_chain','variance','returnables','return_reasons')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_ref text not null,
  facts jsonb not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(org_unit_id with =,kind with =,tstzrange(effective_from,effective_to,'[)') with &&)
);

create table van_trip_observations (
  id uuid primary key,
  trip_id uuid not null references van_trips(id),
  client_op_id uuid not null,
  kind text not null check(kind in ('temperature','returnable','unload','reload_request')),
  outlet_id uuid references outlets(id),
  policy_id uuid references van_policy_versions(id),
  captured_at timestamptz not null,
  recorded_by uuid not null references profiles(id),
  device_id uuid not null references registered_devices(id),
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(device_id,client_op_id)
);
create index van_observations_trip on van_trip_observations(trip_id,kind,captured_at,id);
create unique index van_one_unload on van_trip_observations(trip_id) where kind='unload';

create table van_observation_decisions (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references van_trip_observations(id),
  decision text not null check(decision in ('released','quarantine','received')),
  facts jsonb not null,
  actor_profile_id uuid not null references profiles(id),
  movement_id uuid references inventory_movements(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(observation_id)
);

create table van_settlements (
  id uuid primary key,
  trip_id uuid not null references van_trips(id),
  version integer not null check(version>0),
  content_hash text not null,
  facts jsonb not null,
  submitted_by uuid not null references profiles(id),
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(trip_id,version)
);
create table van_settlement_decisions (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references van_settlements(id),
  decision text not null check(decision in ('approved','rejected')),
  note text not null,
  actor_profile_id uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(settlement_id)
);
create table van_variance_cases (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null unique references van_settlements(id),
  policy_id uuid not null references van_policy_versions(id),
  sales_centavos bigint not null,
  variance_centavos bigint,
  tolerance_basis_points integer not null,
  level text not null check(level in ('supervisor','area_manager','disposed')),
  due_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table van_variance_decisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references van_variance_cases(id),
  action text not null check(action in ('escalate','accept','investigate','recover')),
  note text not null,
  actor_profile_id uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SEAM(SAP): a durable operational request, NOT a SAP posting acknowledgement or valuation.
create table van_sap_requests (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  kind text not null,
  facts jsonb not null,
  status text not null default 'pending' check(status in ('pending','acknowledged','refused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id,kind)
);

create function vanops_immutable() returns trigger language plpgsql as $$
begin raise exception 'Van evidence is append-only'; end;
$$;
create trigger van_observation_immutable before update or delete on van_trip_observations for each row execute function vanops_immutable();
create trigger van_observation_decision_immutable before update or delete on van_observation_decisions for each row execute function vanops_immutable();
create trigger van_settlement_immutable before update or delete on van_settlements for each row execute function vanops_immutable();
create trigger van_settlement_decision_immutable before update or delete on van_settlement_decisions for each row execute function vanops_immutable();
create trigger van_variance_decision_immutable before update or delete on van_variance_decisions for each row execute function vanops_immutable();
