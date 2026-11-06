-- 0762 (IP-VANDAY, SPEC 5.2 step 1, 5.3, 5.4): the weekly van roster, the crew on a trip, the phone that belongs to the
-- truck, and the people who take turns on that phone with a PIN. Nothing here moves stock.

-- Weekly roster: this seller (and helper/driver) drives this vehicle on this route on these weekdays.
-- weekdays are ISO: 1 = Monday ... 7 = Sunday. The nightly job reads it; it never edits it.
create table van_rosters (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  org_unit_id uuid not null references org_units(id),
  vehicle_id uuid not null references vehicles(id),
  route_id uuid references routes(id),
  seller_profile_id uuid not null references profiles(id),
  helper_profile_id uuid references profiles(id),
  driver_profile_id uuid references profiles(id),
  source_location_id uuid references inventory_locations(id),
  weekdays smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]::smallint[]),
  effective_from date not null,
  effective_to date,
  status text not null default 'active' check (status in ('active', 'ended')),
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (effective_to is null or effective_to >= effective_from)
);
create index van_rosters_vehicle_idx on van_rosters (vehicle_id) where deleted_at is null;
create index van_rosters_unit_idx on van_rosters (org_unit_id, status) where deleted_at is null;

-- Trips come from the roster (or by hand). One roster row can make at most one trip per day.
alter table van_trips
  add column roster_id uuid references van_rosters(id),
  add column generated_by text check (generated_by is null or generated_by in ('nightly', 'generate', 'copy'));
create index van_trips_roster_idx on van_trips (roster_id, service_date) where roster_id is not null;

-- The crew of a trip: seller (accountable for cash), helper, driver, relief. History is kept (ended_at).
create table van_trip_crew (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  trip_id uuid not null references van_trips(id),
  profile_id uuid not null references profiles(id),
  role text not null check (role in ('seller', 'helper', 'driver', 'relief')),
  source text not null check (source in ('roster', 'manual', 'handover')),
  added_by text not null,
  added_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by text
);
create unique index van_trip_crew_active on van_trip_crew (trip_id, profile_id, role) where ended_at is null;
create index van_trip_crew_profile_idx on van_trip_crew (profile_id) where ended_at is null;

-- A phone belongs to the truck, not the person. One live binding per phone and per truck.
create table van_device_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  device_id uuid not null references registered_devices(id),
  vehicle_id uuid not null references vehicles(id),
  bound_by text not null,
  bound_at timestamptz not null default now(),
  released_at timestamptz,
  released_by text,
  note text
);
create unique index van_device_bindings_device_live on van_device_bindings (device_id) where released_at is null;
create unique index van_device_bindings_vehicle_live on van_device_bindings (vehicle_id) where released_at is null;

-- Each crew member's own PIN for taking over the shared phone. Same one-way scheme as the supervisor PINs:
-- the phone gets salt + hash to check a PIN offline, and signs the switch with the key it derives from the PIN.
create table van_crew_pins (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  pin_salt text not null,
  pin_hash text not null,
  pin_key text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  set_by uuid references profiles(id),
  set_at timestamptz not null default now()
);
create unique index van_crew_pins_live on van_crew_pins (profile_id) where effective_to is null;
create table van_crew_pin_attempts (
  profile_id uuid primary key references profiles(id),
  failures integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

-- Who is on the phone, and since when. A switch ends one row and starts another; the phone itself is untouched
-- (never revoked, never re-enrolled), so nobody sees "Phone removed".
create table van_crew_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  device_id uuid not null references registered_devices(id),
  vehicle_id uuid references vehicles(id),
  trip_id uuid references van_trips(id),
  profile_id uuid not null references profiles(id),
  role text not null check (role in ('seller', 'helper', 'driver', 'relief')),
  method text not null check (method in ('start', 'pin_online', 'pin_offline', 'handover', 'office')),
  started_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text,
  switched_from uuid references van_crew_sessions(id),
  client_op_id text,
  recorded_by text not null,
  created_at timestamptz not null default now()
);
create unique index van_crew_sessions_live on van_crew_sessions (device_id) where ended_at is null;
create unique index van_crew_sessions_op on van_crew_sessions (client_op_id) where client_op_id is not null;
create index van_crew_sessions_trip_idx on van_crew_sessions (trip_id, started_at);

-- The person on the phone when each handheld operation was made, kept beside the operation (the sale itself stays the
-- seller's, because the seller is accountable for the trip).
create table van_crew_actions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references van_trips(id),
  device_id uuid not null references registered_devices(id),
  session_id uuid references van_crew_sessions(id),
  profile_id uuid not null references profiles(id),
  op_type text not null,
  client_op_id text not null unique,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create index van_crew_actions_trip_idx on van_crew_actions (trip_id, occurred_at);

-- Must-carry products for a route (SPEC glossary: "Must-carry products"). Route null = every route of the unit.
create table van_must_carry (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  org_unit_id uuid references org_units(id),
  route_id uuid references routes(id),
  product_id uuid not null references products(id),
  min_base bigint not null check (min_base > 0),
  active boolean not null default true,
  set_by text not null,
  set_at timestamptz not null default now()
);
create unique index van_must_carry_live on van_must_carry (coalesce(route_id, '00000000-0000-0000-0000-000000000000'::uuid), product_id) where active;
