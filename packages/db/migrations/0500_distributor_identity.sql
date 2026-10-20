-- F-401/F-402/F-407: partner identities have NO employee capabilities.
-- A partner's permissions are effective memberships, never the Sunpride org subtree.
alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check check(role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer','distributor'));

create table distributors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique, name text not null,
  org_unit_id uuid not null references org_units(id),
  status text not null default 'applicant' check(status in ('applicant','review','accredited','suspended','rejected')),
  sap_customer_code text unique,
  source text not null check(source in ('sample','office','sap')),
  effective_from timestamptz not null default now(), effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to > effective_from)
);
create table distributor_users (
  id uuid primary key default gen_random_uuid(),
  distributor_id uuid not null references distributors(id),
  profile_id uuid not null references profiles(id),
  grants text[] not null default '{}',
  effective_from timestamptz not null default now(), effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  exclude using gist(profile_id with =, tstzrange(effective_from,effective_to,'[)') with &&),
  check(effective_to is null or effective_to > effective_from)
);
create table distributor_master_versions (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  source text not null check(source in ('sample','sap')), source_key text not null,
  version bigint not null check(version > 0), payload_hash text not null, payload jsonb not null,
  effective_from timestamptz not null, effective_to timestamptz, received_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(distributor_id,version), check(effective_to is null or effective_to > effective_from)
);
create table distributor_outlets (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  outlet_id uuid not null references outlets(id), territory_id uuid references territories(id),
  master_version_id uuid not null references distributor_master_versions(id),
  effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  exclude using gist(distributor_id with =, outlet_id with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create table distributor_locations (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  code text not null, name text not null, kind text not null check(kind in ('warehouse','van')),
  inventory_location_id uuid references inventory_locations(id),
  effective_from timestamptz not null default now(), effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(distributor_id,code)
);
create table distributor_policies (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  version integer not null check(version > 0), settings jsonb not null,
  effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(distributor_id,version),
  exclude using gist(distributor_id with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create table distributor_commands (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  actor_id uuid not null references profiles(id), request_key text not null, payload_hash text not null, response jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,actor_id,request_key)
);
create table distributor_events (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  actor_id uuid not null references profiles(id), action text not null, entity_id uuid, details jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index distributor_events_partner on distributor_events(distributor_id,created_at,id);
-- F-403: extend the ONE canonical commercial order, not a partner order clone.
alter table orders add column purchasing_distributor_id uuid references distributors(id);
alter table orders add column customer_po_number text;
alter table orders add column acknowledged_at timestamptz;
alter table orders add column promised_delivery_date date;
alter table orders add column sap_acknowledgement jsonb;
create unique index distributor_order_po on orders(purchasing_distributor_id,customer_po_number) where purchasing_distributor_id is not null;
