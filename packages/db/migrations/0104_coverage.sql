-- 0104_coverage: Coverage plans (MCP), slots, planned visits.
-- Domain baseline; typed row definitions live in packages/db/src/tables/.
-- Tables: coverage_plans, coverage_plan_territories, coverage_assignments, coverage_plan_outlets, coverage_plan_slots, position_routine_templates, position_routine_template_activities, planned_visits, supervisor_away_periods, coverage_audit_events.

-- coveragePlans [synced]
create table coverage_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  assignee_profile_id uuid not null,
  local_month text not null check (local_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  version integer not null,
  cycle_type text not null check (cycle_type in ('monthly')),
  org_unit_id uuid not null,
  requested_from timestamptz not null,
  requested_to timestamptz not null,
  effective_from timestamptz not null,
  effective_to timestamptz not null,
  status text not null check (status in ('draft', 'submitted', 'approved', 'active', 'superseded')),
  based_on_plan_id uuid,
  revision_reason text,
  prepared_by text not null,
  prepared_at timestamptz not null,
  submitted_by text,
  submitted_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  approval_signature text,
  approver_profile_id uuid,
  approval_capacity text check (approval_capacity in ('supervisor', 'backup', 'scope_approver')),
  approved_on_behalf_of_profile_id uuid,
  activated_at timestamptz,
  superseded_at timestamptz,
  active_through timestamptz,
  content_revision integer not null,
  content_hash text,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index coverage_plans_org_assignee_month_version_key on coverage_plans (organization_id, assignee_profile_id, local_month, version);
create index coverage_plans_org_month_status_idx on coverage_plans (organization_id, local_month, status);
create index coverage_plans_assignee_profile_id_and_local_month_and_c21b29af on coverage_plans (assignee_profile_id, local_month, status);
create index coverage_plans_org_unit_id_and_local_month_and_status_idx on coverage_plans (org_unit_id, local_month, status);
create index coverage_plans_status_and_effective_from_idx on coverage_plans (status, effective_from);
create index coverage_plans_change_seq_idx on coverage_plans (change_seq);
create trigger coverage_plans_bump_change_seq before update on coverage_plans for each row execute function bump_change_seq();

-- coveragePlans (coveragePlans.territoryIds[]) [synced]
create table coverage_plan_territories (
  id uuid primary key default gen_random_uuid(),
  coverage_plan_id uuid not null,
  ordinal integer not null,
  territory_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index coverage_plan_territories_parent_ordinal_key on coverage_plan_territories (coverage_plan_id, ordinal);
create index coverage_plan_territories_change_seq_idx on coverage_plan_territories (change_seq);
create trigger coverage_plan_territories_bump_change_seq before update on coverage_plan_territories for each row execute function bump_change_seq();

-- coverageAssignments
create table coverage_assignments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  assignee_profile_id uuid not null,
  org_unit_id uuid not null,
  is_primary boolean not null,
  effective_from timestamptz not null,
  effective_to timestamptz not null,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coverage_assignments_plan_id_and_effective_from_idx on coverage_assignments (plan_id, effective_from);
create index coverage_assignments_assignee_profile_id_and_effective_from_idx on coverage_assignments (assignee_profile_id, effective_from);
create trigger coverage_assignments_set_updated_at before update on coverage_assignments for each row execute function set_updated_at();

-- coveragePlanOutlets
create table coverage_plan_outlets (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  outlet_id uuid not null,
  route_id uuid,
  territory_id uuid not null,
  frequency text not null check (frequency in ('weekly', 'biweekly', 'monthly', 'custom')),
  anchor_local_date date,
  week_ordinal integer,
  preferred_weekdays smallint[] default '{}' not null check (preferred_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  custom_local_dates date[] default '{}' not null,
  sequence integer,
  priority integer not null,
  expected_duration_minutes integer not null,
  required_objectives text[] default '{}' not null,
  visit_window text,
  content_revision integer not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index coverage_plan_outlets_plan_id_and_outlet_id_key on coverage_plan_outlets (plan_id, outlet_id);
create index coverage_plan_outlets_outlet_id_and_plan_id_idx on coverage_plan_outlets (outlet_id, plan_id);
create trigger coverage_plan_outlets_set_updated_at before update on coverage_plan_outlets for each row execute function set_updated_at();

-- coveragePlanSlots [synced]
create table coverage_plan_slots (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null,
  plan_id uuid not null,
  assignee_profile_id uuid not null,
  service_date date not null,
  kind text not null check (kind in ('outlet_visit', 'non_visit')),
  outlet_id uuid,
  route_id uuid,
  activity_kind text,
  named_truck_ref text,
  required_objectives text[] default '{}' not null,
  intents text[] default '{}' not null,
  sequence integer not null,
  expected_duration_minutes integer not null,
  approved_snapshot jsonb,
  content_revision integer not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index coverage_plan_slots_plan_id_and_service_date_idx on coverage_plan_slots (plan_id, service_date);
create unique index coverage_plan_slots_plan_id_and_service_date_and_slot_key_key on coverage_plan_slots (plan_id, service_date, slot_key);
create index coverage_plan_slots_outlet_id_and_service_date_idx on coverage_plan_slots (outlet_id, service_date);
create index coverage_plan_slots_route_id_and_service_date_idx on coverage_plan_slots (route_id, service_date);
create index coverage_plan_slots_change_seq_idx on coverage_plan_slots (change_seq);
create trigger coverage_plan_slots_bump_change_seq before update on coverage_plan_slots for each row execute function bump_change_seq();

-- positionRoutineTemplates
create table position_routine_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  position_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  weekday smallint not null check (weekday in (0, 1, 2, 3, 4, 5, 6)),
  day_kind text not null check (day_kind in ('selling', 'field', 'admin', 'day_off')),
  source_ref text not null,
  provisional boolean not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint position_routine_templates_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint position_routine_templates_no_overlap exclude using gist (position_id with =, weekday with =, tstzrange(effective_from, effective_to, '[)') with &&)
);
create index position_routine_templates_position_id_and_effective_from_idx on position_routine_templates (position_id, effective_from);
create index position_routine_templates_position_id_and_weekday_and_ac07fa3f on position_routine_templates (position_id, weekday, effective_from);
create trigger position_routine_templates_set_updated_at before update on position_routine_templates for each row execute function set_updated_at();

-- positionRoutineTemplates (positionRoutineTemplates.activities[])
create table position_routine_template_activities (
  id uuid primary key default gen_random_uuid(),
  position_routine_template_id uuid not null,
  ordinal integer not null,
  sequence integer not null,
  name text not null,
  kind text not null check (kind in ('outlet_visit', 'non_visit')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index position_routine_template_activities_parent_ordinal_key on position_routine_template_activities (position_routine_template_id, ordinal);
create trigger position_routine_template_activities_set_updated_at before update on position_routine_template_activities for each row execute function set_updated_at();

-- plannedVisits [synced]
create table planned_visits (
  id uuid primary key default gen_random_uuid(),
  generation_key text not null,
  plan_id uuid not null,
  plan_version integer not null,
  plan_slot_id uuid not null,
  assignee_profile_id uuid not null,
  outlet_id uuid not null,
  service_date date not null,
  status text not null check (status in ('planned', 'cancelled', 'replaced')),
  approved_snapshot jsonb not null,
  required_objectives text[] default '{}' not null,
  intents text[] default '{}' not null,
  expected_duration_minutes integer not null,
  generated_at timestamptz not null,
  replaced_by_visit_id uuid,
  replacement_of_visit_id uuid,
  cancellation_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index planned_visits_generation_key_key on planned_visits (generation_key);
create index planned_visits_plan_id_and_service_date_idx on planned_visits (plan_id, service_date);
create index planned_visits_assignee_profile_id_and_service_date_idx on planned_visits (assignee_profile_id, service_date);
create index planned_visits_outlet_id_and_service_date_idx on planned_visits (outlet_id, service_date);
create index planned_visits_change_seq_idx on planned_visits (change_seq);
create trigger planned_visits_bump_change_seq before update on planned_visits for each row execute function bump_change_seq();

-- supervisorAwayPeriods
create table supervisor_away_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  profile_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz not null,
  reason text not null,
  recorded_by text not null,
  recorded_at timestamptz not null,
  ended_by text,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supervisor_away_periods_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint supervisor_away_periods_no_overlap exclude using gist (profile_id with =, tstzrange(effective_from, effective_to, '[)') with &&)
);
create index supervisor_away_periods_profile_id_and_effective_from_idx on supervisor_away_periods (profile_id, effective_from);
create trigger supervisor_away_periods_set_updated_at before update on supervisor_away_periods for each row execute function set_updated_at();

-- coverageAuditEvents
create table coverage_audit_events (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  assignee_profile_id uuid not null,
  org_unit_id uuid not null,
  local_month text not null check (local_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  actor_subject text not null,
  action text not null,
  reason text,
  affected_entity text not null,
  affected_row_id text,
  before jsonb,
  after jsonb,
  diff jsonb,
  plan_version integer not null,
  approval_signature_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coverage_audit_events_plan_id_and_created_at_idx on coverage_audit_events (plan_id, created_at);
create index coverage_audit_events_assignee_profile_id_and_created_at_idx on coverage_audit_events (assignee_profile_id, created_at);
create index coverage_audit_events_org_unit_id_and_created_at_idx on coverage_audit_events (org_unit_id, created_at);
create trigger coverage_audit_events_set_updated_at before update on coverage_audit_events for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table coverage_plans add constraint coverage_plans_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table coverage_plans add constraint coverage_plans_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table coverage_plans add constraint coverage_plans_based_on_plan_id_fkey foreign key (based_on_plan_id) references coverage_plans(id);
alter table coverage_plans add constraint coverage_plans_approver_profile_id_fkey foreign key (approver_profile_id) references profiles(id);
alter table coverage_plans add constraint coverage_plans_approved_on_behalf_of_profile_id_fkey foreign key (approved_on_behalf_of_profile_id) references profiles(id);
alter table coverage_plan_territories add constraint coverage_plan_territories_coverage_plan_id_fkey foreign key (coverage_plan_id) references coverage_plans(id) on delete cascade;
alter table coverage_plan_territories add constraint coverage_plan_territories_territory_id_fkey foreign key (territory_id) references territories(id);
alter table coverage_assignments add constraint coverage_assignments_plan_id_fkey foreign key (plan_id) references coverage_plans(id);
alter table coverage_assignments add constraint coverage_assignments_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table coverage_assignments add constraint coverage_assignments_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table coverage_plan_outlets add constraint coverage_plan_outlets_plan_id_fkey foreign key (plan_id) references coverage_plans(id);
alter table coverage_plan_outlets add constraint coverage_plan_outlets_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table coverage_plan_outlets add constraint coverage_plan_outlets_route_id_fkey foreign key (route_id) references routes(id);
alter table coverage_plan_outlets add constraint coverage_plan_outlets_territory_id_fkey foreign key (territory_id) references territories(id);
alter table coverage_plan_slots add constraint coverage_plan_slots_plan_id_fkey foreign key (plan_id) references coverage_plans(id);
alter table coverage_plan_slots add constraint coverage_plan_slots_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table coverage_plan_slots add constraint coverage_plan_slots_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table coverage_plan_slots add constraint coverage_plan_slots_route_id_fkey foreign key (route_id) references routes(id);
alter table position_routine_templates add constraint position_routine_templates_position_id_fkey foreign key (position_id) references positions(id);
alter table position_routine_template_activities add constraint position_routine_template_activities_position_routine__051b9ca2 foreign key (position_routine_template_id) references position_routine_templates(id) on delete cascade;
alter table planned_visits add constraint planned_visits_plan_id_fkey foreign key (plan_id) references coverage_plans(id);
alter table planned_visits add constraint planned_visits_plan_slot_id_fkey foreign key (plan_slot_id) references coverage_plan_slots(id);
alter table planned_visits add constraint planned_visits_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table planned_visits add constraint planned_visits_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table planned_visits add constraint planned_visits_replaced_by_visit_id_fkey foreign key (replaced_by_visit_id) references planned_visits(id);
alter table planned_visits add constraint planned_visits_replacement_of_visit_id_fkey foreign key (replacement_of_visit_id) references planned_visits(id);
alter table supervisor_away_periods add constraint supervisor_away_periods_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table coverage_audit_events add constraint coverage_audit_events_plan_id_fkey foreign key (plan_id) references coverage_plans(id);
alter table coverage_audit_events add constraint coverage_audit_events_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table coverage_audit_events add constraint coverage_audit_events_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);

-- Supporting indexes for foreign keys without a leading index.
create index coverage_plans_based_on_plan_id_fk_idx on coverage_plans (based_on_plan_id);
create index coverage_plans_approver_profile_id_fk_idx on coverage_plans (approver_profile_id);
create index coverage_plans_approved_on_behalf_of_profile_id_fk_idx on coverage_plans (approved_on_behalf_of_profile_id);
create index coverage_plan_territories_territory_id_fk_idx on coverage_plan_territories (territory_id);
create index coverage_assignments_org_unit_id_fk_idx on coverage_assignments (org_unit_id);
create index coverage_plan_outlets_route_id_fk_idx on coverage_plan_outlets (route_id);
create index coverage_plan_outlets_territory_id_fk_idx on coverage_plan_outlets (territory_id);
create index coverage_plan_slots_assignee_profile_id_fk_idx on coverage_plan_slots (assignee_profile_id);
create index planned_visits_plan_slot_id_fk_idx on planned_visits (plan_slot_id);
create index planned_visits_replaced_by_visit_id_fk_idx on planned_visits (replaced_by_visit_id);
create index planned_visits_replacement_of_visit_id_fk_idx on planned_visits (replacement_of_visit_id);
