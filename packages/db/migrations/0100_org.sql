-- 0100_org: Org units, positions, people/profiles, teams, audit log.
-- Domain baseline; typed row definitions live in packages/db/src/tables/.
-- Tables: org_unit_types, org_units, org_unit_parent_edges, positions, position_standards, profiles, access_invitations, employee_assignments, teams, team_memberships, audit_logs.

create extension if not exists btree_gist;

-- Non-synced tables keep updated_at current on UPDATE (synced tables use
-- bump_change_seq() from 0001).
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- orgUnitTypes
create table org_unit_types (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  label text not null,
  level integer not null,
  active boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index org_unit_types_organization_id_and_code_key on org_unit_types (organization_id, code);
create index org_unit_types_organization_id_and_level_idx on org_unit_types (organization_id, level);
create trigger org_unit_types_set_updated_at before update on org_unit_types for each row execute function set_updated_at();

-- orgUnits [synced]
create table org_units (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  name text not null,
  type_code text not null,
  parent_id uuid,
  status text not null check (status in ('active', 'inactive')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index org_units_organization_id_and_code_key on org_units (organization_id, code);
create index org_units_organization_id_and_parent_id_idx on org_units (organization_id, parent_id);
create index org_units_organization_id_and_type_code_and_status_idx on org_units (organization_id, type_code, status);
create index org_units_change_seq_idx on org_units (change_seq);
create trigger org_units_bump_change_seq before update on org_units for each row execute function bump_change_seq();

-- orgUnitParentEdges [synced]
create table org_unit_parent_edges (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null,
  parent_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint org_unit_parent_edges_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint org_unit_parent_edges_no_overlap exclude using gist (unit_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index org_unit_parent_edges_unit_id_and_effective_from_idx on org_unit_parent_edges (unit_id, effective_from);
create index org_unit_parent_edges_parent_id_and_effective_from_idx on org_unit_parent_edges (parent_id, effective_from);
create index org_unit_parent_edges_change_seq_idx on org_unit_parent_edges (change_seq);
create trigger org_unit_parent_edges_bump_change_seq before update on org_unit_parent_edges for each row execute function bump_change_seq();

-- positions
create table positions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  label text not null,
  category text not null check (category in ('leadership', 'supervisory', 'specialist', 'field', 'support')),
  active boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index positions_organization_id_and_code_key on positions (organization_id, code);
create index positions_organization_id_and_active_idx on positions (organization_id, active);
create trigger positions_set_updated_at before update on positions for each row execute function set_updated_at();

-- positionStandards [synced]
create table position_standards (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  position_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  daily_calls_target integer,
  productive_call_target_pct double precision,
  work_with_weekly_min integer,
  work_with_monthly_min integer,
  productive_call_rule text check (productive_call_rule in ('any_listed_activity', 'truck_seller')),
  selling_weekdays integer[] default '{}' not null,
  notes text,
  source_ref text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint position_standards_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint position_standards_no_overlap exclude using gist (position_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index position_standards_position_id_and_effective_from_idx on position_standards (position_id, effective_from);
create index position_standards_position_id_and_source_ref_idx on position_standards (position_id, source_ref);
create index position_standards_organization_id_and_effective_from_idx on position_standards (organization_id, effective_from);
create index position_standards_change_seq_idx on position_standards (change_seq);
create trigger position_standards_bump_change_seq before update on position_standards for each row execute function bump_change_seq();

-- profiles [synced]
create table profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  auth_subject text,
  name text not null,
  email text not null,
  role text not null check (role in ('super_admin', 'admin', 'operations', 'manager', 'approver', 'sales', 'analyst', 'viewer')),
  status text not null check (status in ('active', 'disabled')),
  org_unit_id uuid,
  employee_code text,
  position_id uuid,
  employment_type text check (employment_type in ('sfi_employee', 'adp_personnel', 'third_party')),
  channel_scope text,
  supervisor_subject text,
  effective_from timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index profiles_subject_key on profiles (auth_subject) where auth_subject is not null;
create unique index profiles_email_key on profiles (email);
create index profiles_role_idx on profiles (role);
create unique index profiles_employee_code_key on profiles (employee_code) where employee_code is not null;
create index profiles_org_unit_id_idx on profiles (org_unit_id);
create unique index profiles_user_id_key on profiles (user_id);
create index profiles_change_seq_idx on profiles (change_seq);
create trigger profiles_bump_change_seq before update on profiles for each row execute function bump_change_seq();

-- accessInvitations
create table access_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  role text not null check (role in ('super_admin', 'admin', 'operations', 'manager', 'approver', 'sales', 'analyst', 'viewer')),
  position_id uuid,
  status text not null check (status in ('pending', 'accepted', 'revoked')),
  invited_by text not null,
  invited_at timestamptz not null,
  accepted_at timestamptz,
  profile_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index access_invitations_email_idx on access_invitations (email);
create index access_invitations_status_idx on access_invitations (status);
create trigger access_invitations_set_updated_at before update on access_invitations for each row execute function set_updated_at();

-- employeeAssignments [synced]
create table employee_assignments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  org_unit_id uuid,
  role text not null check (role in ('super_admin', 'admin', 'operations', 'manager', 'approver', 'sales', 'analyst', 'viewer')),
  position_id uuid,
  supervisor_id uuid,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint employee_assignments_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint employee_assignments_no_overlap exclude using gist (profile_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index employee_assignments_profile_id_and_effective_from_idx on employee_assignments (profile_id, effective_from);
create index employee_assignments_org_unit_id_and_effective_from_idx on employee_assignments (org_unit_id, effective_from);
create index employee_assignments_change_seq_idx on employee_assignments (change_seq);
create trigger employee_assignments_bump_change_seq before update on employee_assignments for each row execute function bump_change_seq();

-- teams
create table teams (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  org_unit_id uuid not null,
  status text not null check (status in ('active', 'inactive')),
  supervisor_profile_id uuid,
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index teams_code_key on teams (code);
create index teams_org_unit_id_idx on teams (org_unit_id);
create trigger teams_set_updated_at before update on teams for each row execute function set_updated_at();

-- teamMemberships
create table team_memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  profile_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_subject text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_memberships_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint team_memberships_no_overlap exclude using gist (team_id with =, profile_id with =, tstzrange(effective_from, effective_to, '[)') with &&)
);
create index team_memberships_team_id_and_effective_from_idx on team_memberships (team_id, effective_from);
create index team_memberships_profile_id_and_effective_from_idx on team_memberships (profile_id, effective_from);
create trigger team_memberships_set_updated_at before update on team_memberships for each row execute function set_updated_at();

-- auditLogs
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);
create index audit_logs_created_at_idx on audit_logs (created_at);
create trigger audit_logs_set_updated_at before update on audit_logs for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table org_units add constraint org_units_parent_id_fkey foreign key (parent_id) references org_units(id);
alter table org_unit_parent_edges add constraint org_unit_parent_edges_unit_id_fkey foreign key (unit_id) references org_units(id);
alter table org_unit_parent_edges add constraint org_unit_parent_edges_parent_id_fkey foreign key (parent_id) references org_units(id);
alter table position_standards add constraint position_standards_position_id_fkey foreign key (position_id) references positions(id);
alter table profiles add constraint profiles_user_id_fkey foreign key (user_id) references users(id);
alter table profiles add constraint profiles_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table profiles add constraint profiles_position_id_fkey foreign key (position_id) references positions(id);
alter table access_invitations add constraint access_invitations_position_id_fkey foreign key (position_id) references positions(id);
alter table access_invitations add constraint access_invitations_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table employee_assignments add constraint employee_assignments_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table employee_assignments add constraint employee_assignments_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table employee_assignments add constraint employee_assignments_position_id_fkey foreign key (position_id) references positions(id);
alter table employee_assignments add constraint employee_assignments_supervisor_id_fkey foreign key (supervisor_id) references profiles(id);
alter table teams add constraint teams_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table teams add constraint teams_supervisor_profile_id_fkey foreign key (supervisor_profile_id) references profiles(id);
alter table team_memberships add constraint team_memberships_team_id_fkey foreign key (team_id) references teams(id);
alter table team_memberships add constraint team_memberships_profile_id_fkey foreign key (profile_id) references profiles(id);

-- Supporting indexes for foreign keys without a leading index.
create index org_units_parent_id_fk_idx on org_units (parent_id);
create index profiles_position_id_fk_idx on profiles (position_id);
create index access_invitations_position_id_fk_idx on access_invitations (position_id);
create index access_invitations_profile_id_fk_idx on access_invitations (profile_id);
create index employee_assignments_position_id_fk_idx on employee_assignments (position_id);
create index employee_assignments_supervisor_id_fk_idx on employee_assignments (supervisor_id);
create index teams_supervisor_profile_id_fk_idx on teams (supervisor_profile_id);
