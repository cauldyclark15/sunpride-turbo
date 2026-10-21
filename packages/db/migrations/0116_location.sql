-- 0116_location: Location pings and live positions.
-- Domain baseline; typed row definitions live in packages/db/src/tables/.
-- Tables: location_pings, live_locations.

-- locationPings [synced]
create table location_pings (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  kind text not null check (kind in ('field', 'van')),
  profile_id uuid not null,
  device_id uuid,
  client_ping_id text not null,
  org_unit_id uuid not null,
  vehicle_id uuid,
  trip_id uuid,
  visit_id uuid,
  service_date date not null,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_meters double precision not null,
  speed_meters_per_second double precision,
  heading_degrees double precision,
  battery_percent double precision,
  mock_location boolean not null,
  provider text not null check (provider in ('gps', 'network', 'fused', 'unknown')),
  trigger text not null check (trigger in ('start', 'moving', 'still', 'stop')),
  recorded_at timestamptz not null,
  received_at timestamptz not null,
  sample boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index location_pings_device_id_and_client_ping_id_key on location_pings (device_id, client_ping_id);
create index location_pings_profile_id_and_kind_and_recorded_at_idx on location_pings (profile_id, kind, recorded_at);
create index location_pings_org_unit_id_and_recorded_at_idx on location_pings (org_unit_id, recorded_at);
create index location_pings_vehicle_id_and_recorded_at_idx on location_pings (vehicle_id, recorded_at);
create index location_pings_recorded_at_idx on location_pings (recorded_at);
create index location_pings_sample_and_recorded_at_idx on location_pings (sample, recorded_at);
create index location_pings_change_seq_idx on location_pings (change_seq);
create trigger location_pings_bump_change_seq before update on location_pings for each row execute function bump_change_seq();

-- liveLocations [synced]
create table live_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  kind text not null check (kind in ('field', 'van')),
  subject_key text not null,
  profile_id uuid not null,
  device_id uuid,
  org_unit_id uuid not null,
  vehicle_id uuid,
  trip_id uuid,
  visit_id uuid,
  service_date date not null,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_meters double precision not null,
  speed_meters_per_second double precision,
  heading_degrees double precision,
  battery_percent double precision,
  mock_location boolean not null,
  provider text not null check (provider in ('gps', 'network', 'fused', 'unknown')),
  trigger text not null check (trigger in ('start', 'moving', 'still', 'stop')),
  recorded_at timestamptz not null,
  received_at timestamptz not null,
  tracking_ended boolean not null,
  sample boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index live_locations_subject_key_key on live_locations (subject_key);
create index live_locations_org_unit_id_and_recorded_at_idx on live_locations (org_unit_id, recorded_at);
create index live_locations_profile_id_and_recorded_at_idx on live_locations (profile_id, recorded_at);
create index live_locations_vehicle_id_idx on live_locations (vehicle_id);
create index live_locations_recorded_at_idx on live_locations (recorded_at);
create index live_locations_change_seq_idx on live_locations (change_seq);
create trigger live_locations_bump_change_seq before update on live_locations for each row execute function bump_change_seq();

-- Foreign keys (added after every table in this file exists).
alter table location_pings add constraint location_pings_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table location_pings add constraint location_pings_device_id_fkey foreign key (device_id) references registered_devices(id);
alter table location_pings add constraint location_pings_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table location_pings add constraint location_pings_vehicle_id_fkey foreign key (vehicle_id) references vehicles(id);
alter table location_pings add constraint location_pings_trip_id_fkey foreign key (trip_id) references van_trips(id);
alter table location_pings add constraint location_pings_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table live_locations add constraint live_locations_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table live_locations add constraint live_locations_device_id_fkey foreign key (device_id) references registered_devices(id);
alter table live_locations add constraint live_locations_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table live_locations add constraint live_locations_vehicle_id_fkey foreign key (vehicle_id) references vehicles(id);
alter table live_locations add constraint live_locations_trip_id_fkey foreign key (trip_id) references van_trips(id);
alter table live_locations add constraint live_locations_visit_id_fkey foreign key (visit_id) references visit_executions(id);

-- Supporting indexes for foreign keys without a leading index.
create index location_pings_trip_id_fk_idx on location_pings (trip_id);
create index location_pings_visit_id_fk_idx on location_pings (visit_id);
create index live_locations_device_id_fk_idx on live_locations (device_id);
create index live_locations_trip_id_fk_idx on live_locations (trip_id);
create index live_locations_visit_id_fk_idx on live_locations (visit_id);
