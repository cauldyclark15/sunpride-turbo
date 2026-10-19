-- ORG-owned runtime additions; frozen 01xx migrations are unchanged.
alter table access_invitations add column org_unit_id uuid references org_units(id);
alter table profiles add column scope_epoch bigint not null default 1;
create unique index access_invitations_pending_email_key on access_invitations (lower(email)) where status = 'pending';

alter table profiles add column search_vector tsvector generated always as (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(email,'') || ' ' || coalesce(employee_code,''))) stored;
alter table outlets add column search_vector tsvector generated always as (to_tsvector('simple', code || ' ' || name || ' ' || coalesce(address,''))) stored;
alter table products add column search_vector tsvector generated always as (to_tsvector('simple', code || ' ' || name || ' ' || category)) stored;
alter table customers add column search_vector tsvector generated always as (to_tsvector('simple', code || ' ' || name || ' ' || channel)) stored;
create index profiles_search_gin on profiles using gin(search_vector);
create index outlets_search_gin on outlets using gin(search_vector);
create index products_search_gin on products using gin(search_vector);
create index customers_search_gin on customers using gin(search_vector);

create table org_command_receipts (
  profile_id uuid not null references profiles(id),
  command text not null,
  request_key text not null,
  payload_hash text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, command, request_key)
);
-- Same pair must not overlap, including secondary assignments.
alter table territory_salespeople add constraint territory_salespeople_pair_no_overlap exclude using gist (territory_id with =, profile_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null);
alter table route_salespeople add constraint route_salespeople_pair_no_overlap exclude using gist (route_id with =, profile_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null);
create unique index outlet_assignments_route_sequence_key on outlet_assignments (route_id, sequence, effective_from) where route_id is not null and deleted_at is null and (effective_to is null or effective_to > effective_from);
