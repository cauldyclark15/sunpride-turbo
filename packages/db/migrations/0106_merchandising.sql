-- 0106_merchandising: Merchandising audits and assortments.
-- Domain baseline; typed row definitions live in packages/db/src/tables/.
-- Tables: outlet_assortments, outlet_assortment_products, merchandising_audits, merchandising_audit_missing_products, merchandising_audit_evidence, merchandising_availability, merchandising_availability_evidence, merchandising_compliance_checks, merchandising_compliance_check_evidence, competitor_observations, competitor_observation_evidence.

-- outletAssortments [synced]
create table outlet_assortments (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  outlet_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_ref text not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint outlet_assortments_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint outlet_assortments_no_overlap exclude using gist (outlet_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index outlet_assortments_outlet_id_and_effective_from_idx on outlet_assortments (outlet_id, effective_from);
create index outlet_assortments_change_seq_idx on outlet_assortments (change_seq);
create trigger outlet_assortments_bump_change_seq before update on outlet_assortments for each row execute function bump_change_seq();

-- outletAssortments (outletAssortments.productIds[]) [synced]
create table outlet_assortment_products (
  id uuid primary key default gen_random_uuid(),
  outlet_assortment_id uuid not null,
  ordinal integer not null,
  product_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index outlet_assortment_products_parent_ordinal_key on outlet_assortment_products (outlet_assortment_id, ordinal);
create index outlet_assortment_products_change_seq_idx on outlet_assortment_products (change_seq);
create trigger outlet_assortment_products_bump_change_seq before update on outlet_assortment_products for each row execute function bump_change_seq();

-- merchandisingAudits [synced]
create table merchandising_audits (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  visit_id uuid not null,
  outlet_id uuid not null,
  assignee_profile_id uuid not null,
  service_date date not null,
  client_audit_id text not null,
  payload_hash text not null,
  audit_version text not null,
  assortment_id uuid,
  required_count integer not null,
  required_available_count integer not null,
  required_out_of_stock_count integer not null,
  actor_subject text not null,
  source text not null check (source in ('mobile', 'web')),
  device_time timestamptz not null,
  server_time timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index merchandising_audits_visit_id_idx on merchandising_audits (visit_id);
create unique index merchandising_audits_organization_id_and_client_audit_id_key on merchandising_audits (organization_id, client_audit_id);
create index merchandising_audits_org_unit_id_and_service_date_idx on merchandising_audits (org_unit_id, service_date);
create index merchandising_audits_outlet_id_and_service_date_idx on merchandising_audits (outlet_id, service_date);
create index merchandising_audits_change_seq_idx on merchandising_audits (change_seq);
create trigger merchandising_audits_bump_change_seq before update on merchandising_audits for each row execute function bump_change_seq();

-- merchandisingAudits (merchandisingAudits.missingRequiredProductIds[]) [synced]
create table merchandising_audit_missing_products (
  id uuid primary key default gen_random_uuid(),
  merchandising_audit_id uuid not null,
  ordinal integer not null,
  product_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index merchandising_audit_missing_products_parent_ordinal_key on merchandising_audit_missing_products (merchandising_audit_id, ordinal);
create index merchandising_audit_missing_products_change_seq_idx on merchandising_audit_missing_products (change_seq);
create trigger merchandising_audit_missing_products_bump_change_seq before update on merchandising_audit_missing_products for each row execute function bump_change_seq();

-- merchandisingAudits (merchandisingAudits.evidenceIds[]) [synced]
create table merchandising_audit_evidence (
  id uuid primary key default gen_random_uuid(),
  merchandising_audit_id uuid not null,
  ordinal integer not null,
  evidence_file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index merchandising_audit_evidence_parent_ordinal_key on merchandising_audit_evidence (merchandising_audit_id, ordinal);
create index merchandising_audit_evidence_change_seq_idx on merchandising_audit_evidence (change_seq);
create trigger merchandising_audit_evidence_bump_change_seq before update on merchandising_audit_evidence for each row execute function bump_change_seq();

-- merchandisingAvailability [synced]
create table merchandising_availability (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  audit_id uuid not null,
  outlet_id uuid not null,
  product_id uuid not null,
  service_date date not null,
  required boolean not null,
  status text not null check (status in ('available', 'low_stock', 'out_of_stock', 'not_carried')),
  facings integer,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index merchandising_availability_audit_id_idx on merchandising_availability (audit_id);
create index merchandising_availability_product_id_and_service_date_idx on merchandising_availability (product_id, service_date);
create index merchandising_availability_org_unit_id_and_service_date_idx on merchandising_availability (org_unit_id, service_date);
create index merchandising_availability_change_seq_idx on merchandising_availability (change_seq);
create trigger merchandising_availability_bump_change_seq before update on merchandising_availability for each row execute function bump_change_seq();

-- merchandisingAvailability (merchandisingAvailability.evidenceIds[]) [synced]
create table merchandising_availability_evidence (
  id uuid primary key default gen_random_uuid(),
  merchandising_availability_id uuid not null,
  ordinal integer not null,
  evidence_file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index merchandising_availability_evidence_parent_ordinal_key on merchandising_availability_evidence (merchandising_availability_id, ordinal);
create index merchandising_availability_evidence_change_seq_idx on merchandising_availability_evidence (change_seq);
create trigger merchandising_availability_evidence_bump_change_seq before update on merchandising_availability_evidence for each row execute function bump_change_seq();

-- merchandisingComplianceChecks [synced]
create table merchandising_compliance_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  audit_id uuid not null,
  outlet_id uuid not null,
  service_date date not null,
  kind text not null check (kind in ('display', 'price_tag', 'promotion', 'freezer_placement', 'shelf_share', 'product_freshness')),
  finding text not null check (finding in ('compliant', 'non_compliant', 'not_present', 'not_applicable')),
  program_ref text,
  share_of_shelf_percent double precision,
  action_taken text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index merchandising_compliance_checks_audit_id_idx on merchandising_compliance_checks (audit_id);
create index merchandising_compliance_checks_org_unit_id_and_kind_a_ac460459 on merchandising_compliance_checks (org_unit_id, kind, service_date);
create index merchandising_compliance_checks_change_seq_idx on merchandising_compliance_checks (change_seq);
create trigger merchandising_compliance_checks_bump_change_seq before update on merchandising_compliance_checks for each row execute function bump_change_seq();

-- merchandisingComplianceChecks (merchandisingComplianceChecks.evidenceIds[]) [synced]
create table merchandising_compliance_check_evidence (
  id uuid primary key default gen_random_uuid(),
  merchandising_compliance_check_id uuid not null,
  ordinal integer not null,
  evidence_file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index merchandising_compliance_check_evidence_parent_ordinal_key on merchandising_compliance_check_evidence (merchandising_compliance_check_id, ordinal);
create index merchandising_compliance_check_evidence_change_seq_idx on merchandising_compliance_check_evidence (change_seq);
create trigger merchandising_compliance_check_evidence_bump_change_seq before update on merchandising_compliance_check_evidence for each row execute function bump_change_seq();

-- competitorObservations [synced]
create table competitor_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  audit_id uuid not null,
  outlet_id uuid not null,
  service_date date not null,
  kind text not null check (kind in ('price', 'promotion', 'display', 'new_product', 'stock_level', 'other')),
  brand text not null,
  product_category text,
  observed_price_minor bigint,
  currency text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index competitor_observations_audit_id_idx on competitor_observations (audit_id);
create index competitor_observations_org_unit_id_and_service_date_idx on competitor_observations (org_unit_id, service_date);
create index competitor_observations_change_seq_idx on competitor_observations (change_seq);
create trigger competitor_observations_bump_change_seq before update on competitor_observations for each row execute function bump_change_seq();

-- competitorObservations (competitorObservations.evidenceIds[]) [synced]
create table competitor_observation_evidence (
  id uuid primary key default gen_random_uuid(),
  competitor_observation_id uuid not null,
  ordinal integer not null,
  evidence_file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index competitor_observation_evidence_parent_ordinal_key on competitor_observation_evidence (competitor_observation_id, ordinal);
create index competitor_observation_evidence_change_seq_idx on competitor_observation_evidence (change_seq);
create trigger competitor_observation_evidence_bump_change_seq before update on competitor_observation_evidence for each row execute function bump_change_seq();

-- Foreign keys (added after every table in this file exists).
alter table outlet_assortments add constraint outlet_assortments_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table outlet_assortment_products add constraint outlet_assortment_products_outlet_assortment_id_fkey foreign key (outlet_assortment_id) references outlet_assortments(id) on delete cascade;
alter table outlet_assortment_products add constraint outlet_assortment_products_product_id_fkey foreign key (product_id) references products(id);
alter table merchandising_audits add constraint merchandising_audits_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table merchandising_audits add constraint merchandising_audits_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table merchandising_audits add constraint merchandising_audits_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table merchandising_audits add constraint merchandising_audits_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table merchandising_audits add constraint merchandising_audits_assortment_id_fkey foreign key (assortment_id) references outlet_assortments(id);
alter table merchandising_audit_missing_products add constraint merchandising_audit_missing_products_merchandising_aud_85aaf1aa foreign key (merchandising_audit_id) references merchandising_audits(id) on delete cascade;
alter table merchandising_audit_missing_products add constraint merchandising_audit_missing_products_product_id_fkey foreign key (product_id) references products(id);
alter table merchandising_audit_evidence add constraint merchandising_audit_evidence_merchandising_audit_id_fkey foreign key (merchandising_audit_id) references merchandising_audits(id) on delete cascade;
alter table merchandising_audit_evidence add constraint merchandising_audit_evidence_evidence_file_id_fkey foreign key (evidence_file_id) references field_evidence_files(id);
alter table merchandising_availability add constraint merchandising_availability_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table merchandising_availability add constraint merchandising_availability_audit_id_fkey foreign key (audit_id) references merchandising_audits(id);
alter table merchandising_availability add constraint merchandising_availability_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table merchandising_availability add constraint merchandising_availability_product_id_fkey foreign key (product_id) references products(id);
alter table merchandising_availability_evidence add constraint merchandising_availability_evidence_merchandising_avai_a0c3cc74 foreign key (merchandising_availability_id) references merchandising_availability(id) on delete cascade;
alter table merchandising_availability_evidence add constraint merchandising_availability_evidence_evidence_file_id_fkey foreign key (evidence_file_id) references field_evidence_files(id);
alter table merchandising_compliance_checks add constraint merchandising_compliance_checks_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table merchandising_compliance_checks add constraint merchandising_compliance_checks_audit_id_fkey foreign key (audit_id) references merchandising_audits(id);
alter table merchandising_compliance_checks add constraint merchandising_compliance_checks_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table merchandising_compliance_check_evidence add constraint merchandising_compliance_check_evidence_merchandising__191a4ec6 foreign key (merchandising_compliance_check_id) references merchandising_compliance_checks(id) on delete cascade;
alter table merchandising_compliance_check_evidence add constraint merchandising_compliance_check_evidence_evidence_file_id_fkey foreign key (evidence_file_id) references field_evidence_files(id);
alter table competitor_observations add constraint competitor_observations_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table competitor_observations add constraint competitor_observations_audit_id_fkey foreign key (audit_id) references merchandising_audits(id);
alter table competitor_observations add constraint competitor_observations_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table competitor_observation_evidence add constraint competitor_observation_evidence_competitor_observation_id_fkey foreign key (competitor_observation_id) references competitor_observations(id) on delete cascade;
alter table competitor_observation_evidence add constraint competitor_observation_evidence_evidence_file_id_fkey foreign key (evidence_file_id) references field_evidence_files(id);

-- Supporting indexes for foreign keys without a leading index.
create index outlet_assortment_products_product_id_fk_idx on outlet_assortment_products (product_id);
create index merchandising_audits_assignee_profile_id_fk_idx on merchandising_audits (assignee_profile_id);
create index merchandising_audits_assortment_id_fk_idx on merchandising_audits (assortment_id);
create index merchandising_audit_missing_products_product_id_fk_idx on merchandising_audit_missing_products (product_id);
create index merchandising_audit_evidence_evidence_file_id_fk_idx on merchandising_audit_evidence (evidence_file_id);
create index merchandising_availability_outlet_id_fk_idx on merchandising_availability (outlet_id);
create index merchandising_availability_evidence_evidence_file_id_fk_idx on merchandising_availability_evidence (evidence_file_id);
create index merchandising_compliance_checks_outlet_id_fk_idx on merchandising_compliance_checks (outlet_id);
create index merchandising_compliance_check_evidence_evidence_file_id_fk_idx on merchandising_compliance_check_evidence (evidence_file_id);
create index competitor_observations_outlet_id_fk_idx on competitor_observations (outlet_id);
create index competitor_observation_evidence_evidence_file_id_fk_idx on competitor_observation_evidence (evidence_file_id);
