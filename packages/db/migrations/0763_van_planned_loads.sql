-- 0763 (IP-VANDAY, SPEC 5.2 steps 1-4, 5.1): the suggested load for a trip and its way onto the truck through the
-- movement document (van load-out), plus the clerk/seller agreement on what actually went on the truck.

-- One planned load per trip (a cancelled one may be replaced). It is a plan until approved; once approved it owns a
-- `van_load_out` stock_transfers document (stock_transfer_id) and the trip's van_trip_loads row (load_id).
create table van_planned_loads (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  trip_id uuid not null references van_trips(id),
  state text not null default 'suggested' check (state in ('suggested', 'approved', 'picking', 'dispatched', 'accepted', 'recount', 'disputed', 'cancelled')),
  source text not null check (source in ('nightly', 'copy', 'manual')),
  copied_from_trip_id uuid references van_trips(id),
  attention text[] not null default '{}',
  facts jsonb not null default '{}'::jsonb,
  edited_by text,
  edited_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  stock_transfer_id uuid references stock_transfers(id),
  load_id uuid references van_trip_loads(id),
  clerk_user_id text,
  clerk_name text,
  seller_signed_at timestamptz,
  clerk_signed_at timestamptz,
  agreement text check (agreement is null or agreement in ('within_tolerance', 'both_agreed', 'supervisor')),
  agreed_at timestamptz,
  difference_value_centavos bigint not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index van_planned_loads_trip_live on van_planned_loads (trip_id) where state <> 'cancelled';
create index van_planned_loads_state_idx on van_planned_loads (state) where state <> 'cancelled';

-- Why a line is what it is: the three inputs, what was already on the truck, and the case rounding.
create table van_planned_load_lines (
  id uuid primary key default gen_random_uuid(),
  planned_load_id uuid not null references van_planned_loads(id),
  product_id uuid not null references products(id),
  average_base bigint not null default 0,
  must_carry_base bigint not null default 0,
  ship_first_base bigint not null default 0,
  on_truck_base bigint not null default 0,
  depot_available_base bigint not null default 0,
  case_base bigint not null default 0,
  history_trips integer not null default 0,
  suggested_base bigint not null check (suggested_base >= 0),
  approved_base bigint check (approved_base is null or approved_base >= 0),
  edited boolean not null default false,
  flags text[] not null default '{}',
  unique (planned_load_id, product_id)
);

-- What each side counted when the seller accepted and when the clerk recounted. Rounds are kept for the record.
create table van_load_counts (
  id uuid primary key default gen_random_uuid(),
  planned_load_id uuid not null references van_planned_loads(id),
  round integer not null,
  side text not null check (side in ('seller', 'clerk')),
  counted_by text not null,
  profile_id uuid references profiles(id),
  device_id uuid references registered_devices(id),
  counted_at timestamptz not null default now(),
  lines jsonb not null,
  note text,
  unique (planned_load_id, round, side)
);

-- The 20:00 job's log: what it made, what was already there, and what needs a person.
create table van_nightly_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  org_unit_id uuid references org_units(id),
  service_date date not null,
  trigger text not null check (trigger in ('nightly', 'generate', 'copy')),
  planned integer not null default 0,
  already_planned integer not null default 0,
  needs_attention integer not null default 0,
  detail jsonb not null default '[]'::jsonb,
  ran_by text not null,
  ran_at timestamptz not null default now()
);
create index van_nightly_runs_day_idx on van_nightly_runs (service_date, ran_at);
