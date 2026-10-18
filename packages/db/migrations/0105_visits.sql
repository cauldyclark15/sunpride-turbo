-- 0105_visits: Visit execution, activities, evidence, tasks, collections.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: visit_executions, visit_activities, visit_activity_evidence, visit_activity_rules, visit_activity_rule_activities, visit_location_evidence, field_tasks, field_task_evidence, field_collections, evidence_upload_claims, field_evidence_files, execution_events.

-- visitExecutions [synced]
create table visit_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  client_visit_id text not null,
  planned_visit_id uuid,
  plan_id uuid,
  slot_id uuid,
  plan_version integer,
  assignee_profile_id uuid not null,
  outlet_id uuid not null,
  org_unit_id uuid not null,
  route_id uuid,
  customer_id uuid,
  service_date date not null,
  source text not null check (source in ('planned', 'unplanned')),
  intents text[] default '{}' not null check (intents <@ array['sell', 'collect', 'merchandise', 'audit', 'deliver', 'promotion', 'complaint', 'follow-up']::text[]),
  state text not null check (state in ('planned', 'arrived', 'checked-in', 'in-progress', 'checked-out', 'completed', 'skipped', 'rescheduled', 'missed')),
  outcome text,
  reason_code text,
  unplanned_reason text,
  productivity text not null check (productivity in ('pending', 'verified', 'nonproductive')),
  rule_version text,
  last_server_time timestamptz not null,
  arrived_at timestamptz,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  completed_at timestamptz,
  skipped_at timestamptz,
  rescheduled_at timestamptz,
  missed_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  call_duration_ms bigint,
  late_sync_at timestamptz,
  late_review_status text check (late_review_status in ('pending_review', 'accepted', 'rejected')),
  activity_rule_version text,
  missing_activities text[] default '{}' not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index visit_executions_org_unit_id_and_late_review_status_an_7d6b2d1c on visit_executions (org_unit_id, late_review_status, service_date);
create index visit_executions_organization_id_and_assignee_profile__7f7afa50 on visit_executions (organization_id, assignee_profile_id, service_date);
create index visit_executions_planned_visit_id_idx on visit_executions (planned_visit_id);
create index visit_executions_outlet_id_and_service_date_idx on visit_executions (outlet_id, service_date);
create unique index visit_executions_organization_id_and_client_visit_id_key on visit_executions (organization_id, client_visit_id);
create index visit_executions_change_seq_idx on visit_executions (change_seq);
create trigger visit_executions_bump_change_seq before update on visit_executions for each row execute function bump_change_seq();

-- visitActivities [synced]
create table visit_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  visit_id uuid not null,
  assignee_profile_id uuid not null,
  outlet_id uuid not null,
  activity_kind text not null check (activity_kind in ('inventory_check', 'merchandising', 'price_check', 'promotion', 'order_intent', 'note', 'call_sheet')),
  activity jsonb not null,
  device_time timestamptz not null,
  server_time timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index visit_activities_visit_id_and_server_time_idx on visit_activities (visit_id, server_time);
create index visit_activities_change_seq_idx on visit_activities (change_seq);
create trigger visit_activities_bump_change_seq before update on visit_activities for each row execute function bump_change_seq();

-- visitActivities (visitActivities.evidenceIds[]) [synced]
create table visit_activity_evidence (
  id uuid primary key default gen_random_uuid(),
  visit_activity_id uuid not null,
  ordinal integer not null,
  evidence_file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index visit_activity_evidence_parent_ordinal_key on visit_activity_evidence (visit_activity_id, ordinal);
create index visit_activity_evidence_change_seq_idx on visit_activity_evidence (change_seq);
create trigger visit_activity_evidence_bump_change_seq before update on visit_activity_evidence for each row execute function bump_change_seq();

-- visitActivityRules [synced]
create table visit_activity_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  intent text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_ref text not null,
  provisional boolean not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint visit_activity_rules_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint visit_activity_rules_no_overlap exclude using gist (organization_id with =, intent with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index visit_activity_rules_organization_id_and_intent_and_ef_e0fe39ef on visit_activity_rules (organization_id, intent, effective_from);
create index visit_activity_rules_change_seq_idx on visit_activity_rules (change_seq);
create trigger visit_activity_rules_bump_change_seq before update on visit_activity_rules for each row execute function bump_change_seq();

-- visitActivityRules (visitActivityRules.activities[]) [synced]
create table visit_activity_rule_activities (
  id uuid primary key default gen_random_uuid(),
  visit_activity_rule_id uuid not null,
  ordinal integer not null,
  kind text not null check (kind in ('call_sheet', 'merchandising', 'inventory_check', 'price_check', 'promotion', 'order_intent', 'note')),
  required boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index visit_activity_rule_activities_parent_ordinal_key on visit_activity_rule_activities (visit_activity_rule_id, ordinal);
create index visit_activity_rule_activities_change_seq_idx on visit_activity_rule_activities (change_seq);
create trigger visit_activity_rule_activities_bump_change_seq before update on visit_activity_rule_activities for each row execute function bump_change_seq();

-- visitLocationEvidence [synced]
create table visit_location_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  visit_id uuid not null,
  event text not null check (event in ('check_in', 'check_out')),
  latitude double precision,
  longitude double precision,
  provider text not null check (provider in ('gps', 'network', 'fused', 'unknown')),
  accuracy_meters double precision,
  mock_signal boolean,
  integrity_signal text,
  pin_id uuid,
  pin_version text,
  policy_version text not null,
  radius_meters double precision,
  distance_meters double precision,
  result text not null check (result in ('within_radius', 'outside_radius', 'unavailable', 'unreliable')),
  review_status text not null check (review_status in ('pending_review', 'verified', 'approved_exception', 'rejected')),
  device_time timestamptz not null,
  server_time timestamptz not null,
  retention_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index visit_location_evidence_visit_id_and_server_time_idx on visit_location_evidence (visit_id, server_time);
create index visit_location_evidence_org_unit_id_and_review_status__ce570844 on visit_location_evidence (org_unit_id, review_status, server_time);
create index visit_location_evidence_retention_due_at_idx on visit_location_evidence (retention_due_at);
create index visit_location_evidence_change_seq_idx on visit_location_evidence (change_seq);
create trigger visit_location_evidence_bump_change_seq before update on visit_location_evidence for each row execute function bump_change_seq();

-- fieldTasks [synced]
create table field_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  assignee_profile_id uuid not null,
  plan_id uuid,
  outlet_id uuid,
  visit_id uuid,
  kind text not null check (kind in ('inventory_check', 'merchandising', 'price_check', 'promotion', 'follow_up')),
  required boolean not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  status text not null check (status in ('open', 'completed', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index field_tasks_assignee_profile_id_and_effective_from_idx on field_tasks (assignee_profile_id, effective_from);
create index field_tasks_visit_id_idx on field_tasks (visit_id);
create index field_tasks_change_seq_idx on field_tasks (change_seq);
create trigger field_tasks_bump_change_seq before update on field_tasks for each row execute function bump_change_seq();

-- fieldTasks (fieldTasks.evidenceIds[]) [synced]
create table field_task_evidence (
  id uuid primary key default gen_random_uuid(),
  field_task_id uuid not null,
  ordinal integer not null,
  evidence_file_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index field_task_evidence_parent_ordinal_key on field_task_evidence (field_task_id, ordinal);
create index field_task_evidence_change_seq_idx on field_task_evidence (change_seq);
create trigger field_task_evidence_bump_change_seq before update on field_task_evidence for each row execute function bump_change_seq();

-- fieldCollections [synced]
create table field_collections (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  customer_id uuid not null,
  outlet_id uuid not null,
  visit_id uuid not null,
  assignee_profile_id uuid not null,
  amount_minor bigint not null,
  currency text not null,
  method text not null,
  reference text not null,
  status text not null check (status in ('recorded', 'pending_review', 'rejected')),
  device_time timestamptz not null,
  server_time timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index field_collections_visit_id_and_server_time_idx on field_collections (visit_id, server_time);
create index field_collections_customer_id_and_server_time_idx on field_collections (customer_id, server_time);
create index field_collections_change_seq_idx on field_collections (change_seq);
create trigger field_collections_bump_change_seq before update on field_collections for each row execute function bump_change_seq();

-- evidenceUploadClaims
create table evidence_upload_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  visit_id uuid not null,
  profile_id uuid not null,
  device_id uuid,
  subject text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  storage_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index evidence_upload_claims_visit_id_and_profile_id_idx on evidence_upload_claims (visit_id, profile_id);
create index evidence_upload_claims_storage_id_idx on evidence_upload_claims (storage_id);
create index evidence_upload_claims_expires_at_idx on evidence_upload_claims (expires_at);
create trigger evidence_upload_claims_set_updated_at before update on evidence_upload_claims for each row execute function set_updated_at();

-- fieldEvidenceFiles [synced]
create table field_evidence_files (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  storage_id uuid not null,
  visit_id uuid not null,
  activity_id uuid,
  task_id uuid,
  owner_profile_id uuid not null,
  outlet_id uuid not null,
  mime text not null,
  size_bytes bigint not null,
  checksum text not null,
  captured_at timestamptz not null,
  photo_type text,
  uploaded_at timestamptz not null,
  status text not null check (status in ('pending', 'verified', 'rejected')),
  retention_due_at timestamptz,
  redacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index field_evidence_files_visit_id_and_uploaded_at_idx on field_evidence_files (visit_id, uploaded_at);
create index field_evidence_files_org_unit_id_and_uploaded_at_idx on field_evidence_files (org_unit_id, uploaded_at);
create index field_evidence_files_change_seq_idx on field_evidence_files (change_seq);
create trigger field_evidence_files_bump_change_seq before update on field_evidence_files for each row execute function bump_change_seq();

-- executionEvents
create table execution_events (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  entity_type text not null check (entity_type in ('visit', 'activity', 'task', 'collection', 'device', 'order', 'inventory')),
  entity_id text not null,
  kind text not null,
  actor_subject text not null,
  actor_role text not null check (actor_role in ('super_admin', 'admin', 'operations', 'manager', 'approver', 'sales', 'analyst', 'viewer')),
  actor_org_unit_id uuid not null,
  device_id uuid,
  source text not null check (source in ('mobile', 'web', 'system')),
  operation_key text,
  correlation_id text,
  occurred_at timestamptz not null,
  server_at timestamptz not null,
  summary_before text,
  summary_after text,
  summary_reason_code text,
  schema_version integer not null,
  policy_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index execution_events_entity_type_and_entity_id_and_server_at_idx on execution_events (entity_type, entity_id, server_at);
create index execution_events_org_unit_id_and_server_at_idx on execution_events (org_unit_id, server_at);
create index execution_events_organization_id_and_server_at_idx on execution_events (organization_id, server_at);
create trigger execution_events_set_updated_at before update on execution_events for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table visit_executions add constraint visit_executions_planned_visit_id_fkey foreign key (planned_visit_id) references planned_visits(id);
alter table visit_executions add constraint visit_executions_plan_id_fkey foreign key (plan_id) references coverage_plans(id);
alter table visit_executions add constraint visit_executions_slot_id_fkey foreign key (slot_id) references coverage_plan_slots(id);
alter table visit_executions add constraint visit_executions_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table visit_executions add constraint visit_executions_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table visit_executions add constraint visit_executions_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table visit_executions add constraint visit_executions_route_id_fkey foreign key (route_id) references routes(id);
alter table visit_executions add constraint visit_executions_customer_id_fkey foreign key (customer_id) references customers(id);
alter table visit_activities add constraint visit_activities_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table visit_activities add constraint visit_activities_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table visit_activities add constraint visit_activities_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table visit_activities add constraint visit_activities_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table visit_activity_evidence add constraint visit_activity_evidence_visit_activity_id_fkey foreign key (visit_activity_id) references visit_activities(id) on delete cascade;
alter table visit_activity_evidence add constraint visit_activity_evidence_evidence_file_id_fkey foreign key (evidence_file_id) references field_evidence_files(id);
alter table visit_activity_rule_activities add constraint visit_activity_rule_activities_visit_activity_rule_id_fkey foreign key (visit_activity_rule_id) references visit_activity_rules(id) on delete cascade;
alter table visit_location_evidence add constraint visit_location_evidence_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table visit_location_evidence add constraint visit_location_evidence_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table visit_location_evidence add constraint visit_location_evidence_pin_id_fkey foreign key (pin_id) references outlet_pins(id);
alter table field_tasks add constraint field_tasks_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table field_tasks add constraint field_tasks_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table field_tasks add constraint field_tasks_plan_id_fkey foreign key (plan_id) references coverage_plans(id);
alter table field_tasks add constraint field_tasks_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table field_tasks add constraint field_tasks_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table field_task_evidence add constraint field_task_evidence_field_task_id_fkey foreign key (field_task_id) references field_tasks(id) on delete cascade;
alter table field_task_evidence add constraint field_task_evidence_evidence_file_id_fkey foreign key (evidence_file_id) references field_evidence_files(id);
alter table field_collections add constraint field_collections_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table field_collections add constraint field_collections_customer_id_fkey foreign key (customer_id) references customers(id);
alter table field_collections add constraint field_collections_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table field_collections add constraint field_collections_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table field_collections add constraint field_collections_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table evidence_upload_claims add constraint evidence_upload_claims_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table evidence_upload_claims add constraint evidence_upload_claims_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table evidence_upload_claims add constraint evidence_upload_claims_device_id_fkey foreign key (device_id) references registered_devices(id);
alter table evidence_upload_claims add constraint evidence_upload_claims_storage_id_fkey foreign key (storage_id) references files(id);
alter table field_evidence_files add constraint field_evidence_files_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table field_evidence_files add constraint field_evidence_files_storage_id_fkey foreign key (storage_id) references files(id);
alter table field_evidence_files add constraint field_evidence_files_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table field_evidence_files add constraint field_evidence_files_activity_id_fkey foreign key (activity_id) references visit_activities(id);
alter table field_evidence_files add constraint field_evidence_files_task_id_fkey foreign key (task_id) references field_tasks(id);
alter table field_evidence_files add constraint field_evidence_files_owner_profile_id_fkey foreign key (owner_profile_id) references profiles(id);
alter table field_evidence_files add constraint field_evidence_files_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table execution_events add constraint execution_events_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table execution_events add constraint execution_events_actor_org_unit_id_fkey foreign key (actor_org_unit_id) references org_units(id);
alter table execution_events add constraint execution_events_device_id_fkey foreign key (device_id) references registered_devices(id);

-- Supporting indexes for foreign keys without a leading index.
create index visit_executions_plan_id_fk_idx on visit_executions (plan_id);
create index visit_executions_slot_id_fk_idx on visit_executions (slot_id);
create index visit_executions_assignee_profile_id_fk_idx on visit_executions (assignee_profile_id);
create index visit_executions_route_id_fk_idx on visit_executions (route_id);
create index visit_executions_customer_id_fk_idx on visit_executions (customer_id);
create index visit_activities_org_unit_id_fk_idx on visit_activities (org_unit_id);
create index visit_activities_assignee_profile_id_fk_idx on visit_activities (assignee_profile_id);
create index visit_activities_outlet_id_fk_idx on visit_activities (outlet_id);
create index visit_activity_evidence_evidence_file_id_fk_idx on visit_activity_evidence (evidence_file_id);
create index visit_location_evidence_pin_id_fk_idx on visit_location_evidence (pin_id);
create index field_tasks_org_unit_id_fk_idx on field_tasks (org_unit_id);
create index field_tasks_plan_id_fk_idx on field_tasks (plan_id);
create index field_tasks_outlet_id_fk_idx on field_tasks (outlet_id);
create index field_task_evidence_evidence_file_id_fk_idx on field_task_evidence (evidence_file_id);
create index field_collections_org_unit_id_fk_idx on field_collections (org_unit_id);
create index field_collections_outlet_id_fk_idx on field_collections (outlet_id);
create index field_collections_assignee_profile_id_fk_idx on field_collections (assignee_profile_id);
create index evidence_upload_claims_profile_id_fk_idx on evidence_upload_claims (profile_id);
create index evidence_upload_claims_device_id_fk_idx on evidence_upload_claims (device_id);
create index field_evidence_files_storage_id_fk_idx on field_evidence_files (storage_id);
create index field_evidence_files_activity_id_fk_idx on field_evidence_files (activity_id);
create index field_evidence_files_task_id_fk_idx on field_evidence_files (task_id);
create index field_evidence_files_owner_profile_id_fk_idx on field_evidence_files (owner_profile_id);
create index field_evidence_files_outlet_id_fk_idx on field_evidence_files (outlet_id);
create index execution_events_actor_org_unit_id_fk_idx on execution_events (actor_org_unit_id);
create index execution_events_device_id_fk_idx on execution_events (device_id);
