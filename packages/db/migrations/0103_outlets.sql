-- 0103_outlets: Outlets, pins, assignments, enrolment.
-- Domain baseline; typed row definitions live in packages/db/src/tables/.
-- Tables: outlets, outlet_contacts, outlet_photos, outlet_customer_links, outlet_pins, outlet_assignments, outlet_enrolments, outlet_enrolment_photos, outlet_enrolment_events, outlet_code_settings.

-- outlets [synced]
create table outlets (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  name text not null,
  status text not null check (status in ('prospect', 'active', 'inactive')),
  custodian_org_unit_id uuid not null,
  channel text,
  subchannel text,
  classification text,
  address text,
  directions text,
  sales_potential double precision,
  preferred_weekday integer,
  visit_frequency_days integer,
  visit_window text,
  enrolment_status text check (enrolment_status in ('provisional', 'approved', 'rejected')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index outlets_organization_id_and_code_key on outlets (organization_id, code);
create index outlets_custodian_org_unit_id_and_status_idx on outlets (custodian_org_unit_id, status);
create index outlets_change_seq_idx on outlets (change_seq);
create trigger outlets_bump_change_seq before update on outlets for each row execute function bump_change_seq();

-- outlets (outlets.contacts[]) [synced]
create table outlet_contacts (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null,
  ordinal integer not null,
  name text not null,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index outlet_contacts_parent_ordinal_key on outlet_contacts (outlet_id, ordinal);
create index outlet_contacts_change_seq_idx on outlet_contacts (change_seq);
create trigger outlet_contacts_bump_change_seq before update on outlet_contacts for each row execute function bump_change_seq();

-- outlets (outlets.photoStorageIds[]) [synced]
create table outlet_photos (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null,
  ordinal integer not null,
  file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index outlet_photos_parent_ordinal_key on outlet_photos (outlet_id, ordinal);
create index outlet_photos_change_seq_idx on outlet_photos (change_seq);
create trigger outlet_photos_bump_change_seq before update on outlet_photos for each row execute function bump_change_seq();

-- outletCustomerLinks [synced]
create table outlet_customer_links (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null,
  customer_id uuid not null,
  source text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint outlet_customer_links_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint outlet_customer_links_no_overlap exclude using gist (outlet_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index outlet_customer_links_outlet_id_and_effective_from_idx on outlet_customer_links (outlet_id, effective_from);
create index outlet_customer_links_customer_id_and_effective_from_idx on outlet_customer_links (customer_id, effective_from);
create index outlet_customer_links_change_seq_idx on outlet_customer_links (change_seq);
create trigger outlet_customer_links_bump_change_seq before update on outlet_customer_links for each row execute function bump_change_seq();

-- outletPins [synced]
create table outlet_pins (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null,
  latitude double precision not null,
  longitude double precision not null,
  radius_meters double precision not null,
  source text not null,
  evidence_storage_id uuid,
  evidence_note text,
  status text not null check (status in ('pending', 'verified', 'rejected', 'superseded')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  proposed_by text not null,
  proposed_at timestamptz not null,
  verified_by text,
  verified_at timestamptz,
  reviewer_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint outlet_pins_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint outlet_pins_no_overlap exclude using gist (outlet_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (status = 'verified' and deleted_at is null)
);
create index outlet_pins_outlet_id_and_effective_from_idx on outlet_pins (outlet_id, effective_from);
create index outlet_pins_outlet_id_and_status_idx on outlet_pins (outlet_id, status);
create index outlet_pins_change_seq_idx on outlet_pins (change_seq);
create trigger outlet_pins_bump_change_seq before update on outlet_pins for each row execute function bump_change_seq();

-- outletAssignments [synced]
create table outlet_assignments (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null,
  territory_id uuid not null,
  route_id uuid,
  sequence integer,
  preferred_weekday integer,
  cycle_days integer,
  visit_window text,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint outlet_assignments_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint outlet_assignments_no_overlap exclude using gist (outlet_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index outlet_assignments_outlet_id_and_effective_from_idx on outlet_assignments (outlet_id, effective_from);
create index outlet_assignments_territory_id_and_effective_from_idx on outlet_assignments (territory_id, effective_from);
create index outlet_assignments_route_id_and_effective_from_idx on outlet_assignments (route_id, effective_from);
create index outlet_assignments_change_seq_idx on outlet_assignments (change_seq);
create trigger outlet_assignments_bump_change_seq before update on outlet_assignments for each row execute function bump_change_seq();

-- outletEnrolments [synced]
create table outlet_enrolments (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  outlet_id uuid not null,
  org_unit_id uuid not null,
  territory_id uuid,
  pin_id uuid not null,
  status text not null check (status in ('pending', 'approved', 'rejected')),
  provisional_code text not null,
  assigned_code text,
  cis_storage_id uuid,
  client_request_id text not null,
  proposed_by text not null,
  proposed_by_profile_id uuid not null,
  proposed_at timestamptz not null,
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index outlet_enrolments_organization_id_and_status_and_propo_e3079b75 on outlet_enrolments (organization_id, status, proposed_at);
create index outlet_enrolments_proposed_by_profile_id_and_proposed_at_idx on outlet_enrolments (proposed_by_profile_id, proposed_at);
create unique index outlet_enrolments_proposed_by_and_client_request_id_key on outlet_enrolments (proposed_by, client_request_id);
create index outlet_enrolments_outlet_id_idx on outlet_enrolments (outlet_id);
create index outlet_enrolments_change_seq_idx on outlet_enrolments (change_seq);
create trigger outlet_enrolments_bump_change_seq before update on outlet_enrolments for each row execute function bump_change_seq();

-- outletEnrolments (outletEnrolments.photoStorageIds[]) [synced]
create table outlet_enrolment_photos (
  id uuid primary key default gen_random_uuid(),
  outlet_enrolment_id uuid not null,
  ordinal integer not null,
  file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index outlet_enrolment_photos_parent_ordinal_key on outlet_enrolment_photos (outlet_enrolment_id, ordinal);
create index outlet_enrolment_photos_change_seq_idx on outlet_enrolment_photos (change_seq);
create trigger outlet_enrolment_photos_bump_change_seq before update on outlet_enrolment_photos for each row execute function bump_change_seq();

-- outletEnrolmentEvents
create table outlet_enrolment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  enrolment_id uuid not null,
  outlet_id uuid not null,
  org_unit_id uuid not null,
  kind text not null check (kind in ('proposed', 'approved', 'rejected')),
  outlet_name text not null,
  outlet_code text not null,
  actor_name text not null,
  proposed_by_profile_id uuid not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outlet_enrolment_events_organization_id_and_created_at_idx on outlet_enrolment_events (organization_id, created_at);
create trigger outlet_enrolment_events_set_updated_at before update on outlet_enrolment_events for each row execute function set_updated_at();

-- outletCodeSettings
create table outlet_code_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  prefix text not null,
  digits integer not null,
  next_sequence integer not null,
  next_provisional_sequence integer not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index outlet_code_settings_organization_id_key on outlet_code_settings (organization_id);
create trigger outlet_code_settings_set_updated_at before update on outlet_code_settings for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table outlets add constraint outlets_custodian_org_unit_id_fkey foreign key (custodian_org_unit_id) references org_units(id);
alter table outlet_contacts add constraint outlet_contacts_outlet_id_fkey foreign key (outlet_id) references outlets(id) on delete cascade;
alter table outlet_photos add constraint outlet_photos_outlet_id_fkey foreign key (outlet_id) references outlets(id) on delete cascade;
alter table outlet_photos add constraint outlet_photos_file_id_fkey foreign key (file_id) references files(id);
alter table outlet_customer_links add constraint outlet_customer_links_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table outlet_customer_links add constraint outlet_customer_links_customer_id_fkey foreign key (customer_id) references customers(id);
alter table outlet_pins add constraint outlet_pins_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table outlet_pins add constraint outlet_pins_evidence_storage_id_fkey foreign key (evidence_storage_id) references files(id);
alter table outlet_assignments add constraint outlet_assignments_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table outlet_assignments add constraint outlet_assignments_territory_id_fkey foreign key (territory_id) references territories(id);
alter table outlet_assignments add constraint outlet_assignments_route_id_fkey foreign key (route_id) references routes(id);
alter table outlet_enrolments add constraint outlet_enrolments_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table outlet_enrolments add constraint outlet_enrolments_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table outlet_enrolments add constraint outlet_enrolments_territory_id_fkey foreign key (territory_id) references territories(id);
alter table outlet_enrolments add constraint outlet_enrolments_pin_id_fkey foreign key (pin_id) references outlet_pins(id);
alter table outlet_enrolments add constraint outlet_enrolments_cis_storage_id_fkey foreign key (cis_storage_id) references files(id);
alter table outlet_enrolments add constraint outlet_enrolments_proposed_by_profile_id_fkey foreign key (proposed_by_profile_id) references profiles(id);
alter table outlet_enrolment_photos add constraint outlet_enrolment_photos_outlet_enrolment_id_fkey foreign key (outlet_enrolment_id) references outlet_enrolments(id) on delete cascade;
alter table outlet_enrolment_photos add constraint outlet_enrolment_photos_file_id_fkey foreign key (file_id) references files(id);
alter table outlet_enrolment_events add constraint outlet_enrolment_events_enrolment_id_fkey foreign key (enrolment_id) references outlet_enrolments(id);
alter table outlet_enrolment_events add constraint outlet_enrolment_events_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table outlet_enrolment_events add constraint outlet_enrolment_events_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table outlet_enrolment_events add constraint outlet_enrolment_events_proposed_by_profile_id_fkey foreign key (proposed_by_profile_id) references profiles(id);

-- Supporting indexes for foreign keys without a leading index.
create index outlet_photos_file_id_fk_idx on outlet_photos (file_id);
create index outlet_pins_evidence_storage_id_fk_idx on outlet_pins (evidence_storage_id);
create index outlet_enrolments_org_unit_id_fk_idx on outlet_enrolments (org_unit_id);
create index outlet_enrolments_territory_id_fk_idx on outlet_enrolments (territory_id);
create index outlet_enrolments_pin_id_fk_idx on outlet_enrolments (pin_id);
create index outlet_enrolments_cis_storage_id_fk_idx on outlet_enrolments (cis_storage_id);
create index outlet_enrolment_photos_file_id_fk_idx on outlet_enrolment_photos (file_id);
create index outlet_enrolment_events_enrolment_id_fk_idx on outlet_enrolment_events (enrolment_id);
create index outlet_enrolment_events_outlet_id_fk_idx on outlet_enrolment_events (outlet_id);
create index outlet_enrolment_events_org_unit_id_fk_idx on outlet_enrolment_events (org_unit_id);
create index outlet_enrolment_events_proposed_by_profile_id_fk_idx on outlet_enrolment_events (proposed_by_profile_id);
