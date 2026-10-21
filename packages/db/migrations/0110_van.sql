-- 0110_van: Van sales: vehicles, trips, loads, damage, credit terms.
-- Domain baseline; typed row definitions live in packages/db/src/tables/.
-- Tables: vehicles, van_trips, van_trip_loads, van_trip_load_lines, van_operations, van_damage_records, van_damage_photos, outlet_credit_terms.

-- vehicles [synced]
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  vehicle_code text not null,
  plate_number text not null,
  name text,
  truck_location_id uuid not null,
  home_location_id uuid not null,
  capacity_note text,
  status text not null check (status in ('active', 'inactive')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index vehicles_organization_id_and_vehicle_code_key on vehicles (organization_id, vehicle_code);
create index vehicles_truck_location_id_idx on vehicles (truck_location_id);
create index vehicles_org_unit_id_and_status_idx on vehicles (org_unit_id, status);
create index vehicles_change_seq_idx on vehicles (change_seq);
create trigger vehicles_bump_change_seq before update on vehicles for each row execute function bump_change_seq();

-- vanTrips [synced]
create table van_trips (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  trip_number text not null,
  vehicle_id uuid not null,
  truck_location_id uuid not null,
  source_location_id uuid not null,
  route_id uuid,
  service_date date not null,
  salesperson_profile_id uuid not null,
  salesperson_subject text not null,
  driver_name text,
  helper_name text,
  status text not null check (status in ('planned', 'loading', 'loaded', 'active', 'closing', 'reconciling', 'closed', 'cancelled', 'review_required')),
  started_at timestamptz,
  started_device_id uuid,
  start_odometer_km double precision,
  start_note text,
  route_session_id uuid,
  closed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index van_trips_organization_id_and_trip_number_key on van_trips (organization_id, trip_number);
create index van_trips_salesperson_profile_id_and_service_date_idx on van_trips (salesperson_profile_id, service_date);
create index van_trips_vehicle_id_and_service_date_idx on van_trips (vehicle_id, service_date);
create index van_trips_org_unit_id_and_service_date_idx on van_trips (org_unit_id, service_date);
create index van_trips_change_seq_idx on van_trips (change_seq);
create trigger van_trips_bump_change_seq before update on van_trips for each row execute function bump_change_seq();

-- vanTripLoads [synced]
create table van_trip_loads (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  trip_id uuid not null,
  load_number integer not null,
  status text not null check (status in ('planned', 'discrepancy', 'posted', 'cancelled')),
  created_by text not null,
  confirmed_by text,
  confirmed_at timestamptz,
  confirmed_device_id uuid,
  confirm_request_id text,
  approved_by text,
  approved_at timestamptz,
  approval_note text,
  command_key text,
  movement_id uuid,
  stock_transfer_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index van_trip_loads_trip_id_and_load_number_key on van_trip_loads (trip_id, load_number);
create index van_trip_loads_change_seq_idx on van_trip_loads (change_seq);
create trigger van_trip_loads_bump_change_seq before update on van_trip_loads for each row execute function bump_change_seq();

-- vanTripLoadLines [synced]
create table van_trip_load_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  load_id uuid not null,
  trip_id uuid not null,
  line_number integer not null,
  product_id uuid not null,
  product_code text not null,
  uom_code text not null,
  quantity_scale bigint not null,
  lot_id uuid,
  lot_number text,
  expected_base bigint not null,
  actual_base bigint,
  discrepancy_reason text check (discrepancy_reason in ('short_loaded', 'over_loaded', 'damaged_at_loading', 'wrong_item', 'other')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index van_trip_load_lines_load_id_and_line_number_key on van_trip_load_lines (load_id, line_number);
create index van_trip_load_lines_change_seq_idx on van_trip_load_lines (change_seq);
create trigger van_trip_load_lines_bump_change_seq before update on van_trip_load_lines for each row execute function bump_change_seq();

-- vanOperations [synced]
create table van_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  device_id uuid not null,
  profile_id uuid not null,
  kind text not null check (kind in ('trip.start', 'load.confirm', 'truck.damage')),
  client_request_id text not null,
  payload_hash text not null,
  entity_id text not null,
  movement_id uuid,
  server_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index van_operations_profile_id_and_client_request_id_key on van_operations (profile_id, client_request_id);
create index van_operations_device_id_and_server_at_idx on van_operations (device_id, server_at);
create index van_operations_change_seq_idx on van_operations (change_seq);
create trigger van_operations_bump_change_seq before update on van_operations for each row execute function bump_change_seq();

-- vanDamageRecords [synced]
create table van_damage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  trip_id uuid not null,
  org_unit_id uuid not null,
  truck_location_id uuid not null,
  product_id uuid not null,
  product_code text not null,
  uom_code text not null,
  quantity_scale bigint not null,
  quantity_base bigint not null,
  reason text not null check (reason in ('crushed', 'leaking', 'expired', 'spoiled', 'other')),
  note text,
  photo_id uuid,
  needs_approval boolean not null,
  status text not null check (status in ('recorded', 'pending_approval', 'approved', 'rejected')),
  recorded_by text not null,
  recorded_profile_id uuid not null,
  device_id uuid not null,
  client_request_id text not null,
  recorded_at timestamptz not null,
  movement_id uuid not null,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  reversal_movement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index van_damage_records_trip_id_and_recorded_at_idx on van_damage_records (trip_id, recorded_at);
create index van_damage_records_organization_id_and_status_and_reco_48b63895 on van_damage_records (organization_id, status, recorded_at);
create index van_damage_records_organization_id_and_recorded_at_idx on van_damage_records (organization_id, recorded_at);
create index van_damage_records_change_seq_idx on van_damage_records (change_seq);
create trigger van_damage_records_bump_change_seq before update on van_damage_records for each row execute function bump_change_seq();

-- vanDamagePhotos [synced]
create table van_damage_photos (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  profile_id uuid not null,
  device_id uuid not null,
  sha256 text not null,
  storage_id uuid not null,
  size bigint not null,
  damage_record_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index van_damage_photos_profile_id_and_sha256_key on van_damage_photos (profile_id, sha256);
create index van_damage_photos_change_seq_idx on van_damage_photos (change_seq);
create trigger van_damage_photos_bump_change_seq before update on van_damage_photos for each row execute function bump_change_seq();

-- outletCreditTerms [synced]
create table outlet_credit_terms (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  outlet_id uuid not null,
  terms_days integer not null,
  credit_limit_minor bigint not null,
  currency text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_ref text not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint outlet_credit_terms_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint outlet_credit_terms_no_overlap exclude using gist (outlet_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index outlet_credit_terms_outlet_id_and_effective_from_idx on outlet_credit_terms (outlet_id, effective_from);
create index outlet_credit_terms_change_seq_idx on outlet_credit_terms (change_seq);
create trigger outlet_credit_terms_bump_change_seq before update on outlet_credit_terms for each row execute function bump_change_seq();

-- Foreign keys (added after every table in this file exists).
alter table vehicles add constraint vehicles_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table vehicles add constraint vehicles_truck_location_id_fkey foreign key (truck_location_id) references inventory_locations(id);
alter table vehicles add constraint vehicles_home_location_id_fkey foreign key (home_location_id) references inventory_locations(id);
alter table van_trips add constraint van_trips_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table van_trips add constraint van_trips_vehicle_id_fkey foreign key (vehicle_id) references vehicles(id);
alter table van_trips add constraint van_trips_truck_location_id_fkey foreign key (truck_location_id) references inventory_locations(id);
alter table van_trips add constraint van_trips_source_location_id_fkey foreign key (source_location_id) references inventory_locations(id);
alter table van_trips add constraint van_trips_route_id_fkey foreign key (route_id) references routes(id);
alter table van_trips add constraint van_trips_salesperson_profile_id_fkey foreign key (salesperson_profile_id) references profiles(id);
alter table van_trips add constraint van_trips_started_device_id_fkey foreign key (started_device_id) references registered_devices(id);
alter table van_trips add constraint van_trips_route_session_id_fkey foreign key (route_session_id) references truck_route_sessions(id);
alter table van_trip_loads add constraint van_trip_loads_trip_id_fkey foreign key (trip_id) references van_trips(id);
alter table van_trip_loads add constraint van_trip_loads_confirmed_device_id_fkey foreign key (confirmed_device_id) references registered_devices(id);
alter table van_trip_loads add constraint van_trip_loads_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table van_trip_loads add constraint van_trip_loads_stock_transfer_id_fkey foreign key (stock_transfer_id) references stock_transfers(id);
alter table van_trip_load_lines add constraint van_trip_load_lines_load_id_fkey foreign key (load_id) references van_trip_loads(id);
alter table van_trip_load_lines add constraint van_trip_load_lines_trip_id_fkey foreign key (trip_id) references van_trips(id);
alter table van_trip_load_lines add constraint van_trip_load_lines_product_id_fkey foreign key (product_id) references products(id);
alter table van_trip_load_lines add constraint van_trip_load_lines_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table van_operations add constraint van_operations_device_id_fkey foreign key (device_id) references registered_devices(id);
alter table van_operations add constraint van_operations_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table van_operations add constraint van_operations_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table van_damage_records add constraint van_damage_records_trip_id_fkey foreign key (trip_id) references van_trips(id);
alter table van_damage_records add constraint van_damage_records_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table van_damage_records add constraint van_damage_records_truck_location_id_fkey foreign key (truck_location_id) references inventory_locations(id);
alter table van_damage_records add constraint van_damage_records_product_id_fkey foreign key (product_id) references products(id);
alter table van_damage_records add constraint van_damage_records_photo_id_fkey foreign key (photo_id) references van_damage_photos(id);
alter table van_damage_records add constraint van_damage_records_recorded_profile_id_fkey foreign key (recorded_profile_id) references profiles(id);
alter table van_damage_records add constraint van_damage_records_device_id_fkey foreign key (device_id) references registered_devices(id);
alter table van_damage_records add constraint van_damage_records_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table van_damage_records add constraint van_damage_records_reversal_movement_id_fkey foreign key (reversal_movement_id) references inventory_movements(id);
alter table van_damage_photos add constraint van_damage_photos_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table van_damage_photos add constraint van_damage_photos_device_id_fkey foreign key (device_id) references registered_devices(id);
alter table van_damage_photos add constraint van_damage_photos_storage_id_fkey foreign key (storage_id) references files(id);
alter table van_damage_photos add constraint van_damage_photos_damage_record_id_fkey foreign key (damage_record_id) references van_damage_records(id);
alter table outlet_credit_terms add constraint outlet_credit_terms_outlet_id_fkey foreign key (outlet_id) references outlets(id);

-- Supporting indexes for foreign keys without a leading index.
create index vehicles_home_location_id_fk_idx on vehicles (home_location_id);
create index van_trips_truck_location_id_fk_idx on van_trips (truck_location_id);
create index van_trips_source_location_id_fk_idx on van_trips (source_location_id);
create index van_trips_route_id_fk_idx on van_trips (route_id);
create index van_trips_started_device_id_fk_idx on van_trips (started_device_id);
create index van_trips_route_session_id_fk_idx on van_trips (route_session_id);
create index van_trip_loads_confirmed_device_id_fk_idx on van_trip_loads (confirmed_device_id);
create index van_trip_loads_movement_id_fk_idx on van_trip_loads (movement_id);
create index van_trip_loads_stock_transfer_id_fk_idx on van_trip_loads (stock_transfer_id);
create index van_trip_load_lines_trip_id_fk_idx on van_trip_load_lines (trip_id);
create index van_trip_load_lines_product_id_fk_idx on van_trip_load_lines (product_id);
create index van_trip_load_lines_lot_id_fk_idx on van_trip_load_lines (lot_id);
create index van_operations_movement_id_fk_idx on van_operations (movement_id);
create index van_damage_records_org_unit_id_fk_idx on van_damage_records (org_unit_id);
create index van_damage_records_truck_location_id_fk_idx on van_damage_records (truck_location_id);
create index van_damage_records_product_id_fk_idx on van_damage_records (product_id);
create index van_damage_records_photo_id_fk_idx on van_damage_records (photo_id);
create index van_damage_records_recorded_profile_id_fk_idx on van_damage_records (recorded_profile_id);
create index van_damage_records_device_id_fk_idx on van_damage_records (device_id);
create index van_damage_records_movement_id_fk_idx on van_damage_records (movement_id);
create index van_damage_records_reversal_movement_id_fk_idx on van_damage_records (reversal_movement_id);
create index van_damage_photos_device_id_fk_idx on van_damage_photos (device_id);
create index van_damage_photos_storage_id_fk_idx on van_damage_photos (storage_id);
create index van_damage_photos_damage_record_id_fk_idx on van_damage_photos (damage_record_id);
