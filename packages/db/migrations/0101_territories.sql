-- 0101_territories: Territories and routes.
-- Domain baseline; typed row definitions live in packages/db/src/tables/.
-- Tables: territories, territory_ownerships, territory_salespeople, routes, route_territories, route_salespeople.

-- territories [synced]
create table territories (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  name text not null,
  channel text,
  boundary_geo_json text,
  status text not null check (status in ('active', 'inactive')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index territories_organization_id_and_code_key on territories (organization_id, code);
create index territories_organization_id_and_status_idx on territories (organization_id, status);
create index territories_change_seq_idx on territories (change_seq);
create trigger territories_bump_change_seq before update on territories for each row execute function bump_change_seq();

-- territoryOwnerships [synced]
create table territory_ownerships (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null,
  org_unit_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint territory_ownerships_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint territory_ownerships_no_overlap exclude using gist (territory_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index territory_ownerships_territory_id_and_effective_from_idx on territory_ownerships (territory_id, effective_from);
create index territory_ownerships_org_unit_id_and_effective_from_idx on territory_ownerships (org_unit_id, effective_from);
create index territory_ownerships_change_seq_idx on territory_ownerships (change_seq);
create trigger territory_ownerships_bump_change_seq before update on territory_ownerships for each row execute function bump_change_seq();

-- territorySalespeople [synced]
create table territory_salespeople (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null,
  profile_id uuid not null,
  kind text check (kind in ('primary', 'secondary')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index territory_salespeople_territory_id_and_effective_from_idx on territory_salespeople (territory_id, effective_from);
create index territory_salespeople_profile_id_and_effective_from_idx on territory_salespeople (profile_id, effective_from);
create index territory_salespeople_change_seq_idx on territory_salespeople (change_seq);
create trigger territory_salespeople_bump_change_seq before update on territory_salespeople for each row execute function bump_change_seq();

-- routes [synced]
create table routes (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  name text not null,
  status text not null check (status in ('active', 'inactive')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  weekday_template integer[] default '{}' not null,
  cycle_days integer,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index routes_organization_id_and_code_key on routes (organization_id, code);
create index routes_organization_id_and_status_idx on routes (organization_id, status);
create index routes_change_seq_idx on routes (change_seq);
create trigger routes_bump_change_seq before update on routes for each row execute function bump_change_seq();

-- routeTerritories [synced]
create table route_territories (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null,
  territory_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint route_territories_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint route_territories_no_overlap exclude using gist (route_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index route_territories_route_id_and_effective_from_idx on route_territories (route_id, effective_from);
create index route_territories_territory_id_and_effective_from_idx on route_territories (territory_id, effective_from);
create index route_territories_change_seq_idx on route_territories (change_seq);
create trigger route_territories_bump_change_seq before update on route_territories for each row execute function bump_change_seq();

-- routeSalespeople [synced]
create table route_salespeople (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null,
  profile_id uuid not null,
  is_primary boolean not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint route_salespeople_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint route_salespeople_no_overlap exclude using gist (route_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (is_primary and deleted_at is null)
);
create index route_salespeople_route_id_and_effective_from_idx on route_salespeople (route_id, effective_from);
create index route_salespeople_profile_id_and_effective_from_idx on route_salespeople (profile_id, effective_from);
create index route_salespeople_change_seq_idx on route_salespeople (change_seq);
create trigger route_salespeople_bump_change_seq before update on route_salespeople for each row execute function bump_change_seq();

-- Foreign keys (added after every table in this file exists).
alter table territory_ownerships add constraint territory_ownerships_territory_id_fkey foreign key (territory_id) references territories(id);
alter table territory_ownerships add constraint territory_ownerships_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table territory_salespeople add constraint territory_salespeople_territory_id_fkey foreign key (territory_id) references territories(id);
alter table territory_salespeople add constraint territory_salespeople_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table route_territories add constraint route_territories_route_id_fkey foreign key (route_id) references routes(id);
alter table route_territories add constraint route_territories_territory_id_fkey foreign key (territory_id) references territories(id);
alter table route_salespeople add constraint route_salespeople_route_id_fkey foreign key (route_id) references routes(id);
alter table route_salespeople add constraint route_salespeople_profile_id_fkey foreign key (profile_id) references profiles(id);
