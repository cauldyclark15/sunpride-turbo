-- 0112_supervision: Work-with, per diem, talk sheets, trainer forms.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: work_with_sessions, work_with_session_observations, per_diem_validations, talk_sheets, talk_sheet_items, trainer_forms, trainer_form_evaluation_sessions.

-- workWithSessions
create table work_with_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  trainer_profile_id uuid not null,
  trainer_position_id uuid,
  trainee_profile_id uuid not null,
  org_unit_id uuid not null,
  service_date date not null,
  objective text not null check (objective in ('training', 'sales_validation')),
  mode text not null check (mode in ('booking', 'truck')),
  truck_reference text,
  rode_with_truck boolean,
  status text not null check (status in ('open', 'completed', 'cancelled')),
  training_log_topics text,
  training_log_trade_development text,
  training_log_discussed_with_trainee boolean,
  pre_call_documents text[] default '{}' not null check (pre_call_documents <@ array['distribution', 'productivity', 'daily_productive_sales_report', 'call_sheet']::text[]),
  pre_call_remarks text,
  post_call_strengths text,
  post_call_weaknesses text,
  post_call_opportunities text,
  post_call_threats text,
  mcp_planned integer,
  mcp_done integer,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index work_with_sessions_trainer_profile_id_and_service_date_idx on work_with_sessions (trainer_profile_id, service_date);
create index work_with_sessions_trainee_profile_id_and_service_date_idx on work_with_sessions (trainee_profile_id, service_date);
create index work_with_sessions_org_unit_id_and_service_date_idx on work_with_sessions (org_unit_id, service_date);
create trigger work_with_sessions_set_updated_at before update on work_with_sessions for each row execute function set_updated_at();

-- workWithSessions (workWithSessions.observations[])
create table work_with_session_observations (
  id uuid primary key default gen_random_uuid(),
  work_with_session_id uuid not null,
  ordinal integer not null,
  area text not null check (area in ('bcp', 'psf')),
  item text not null,
  rating text not null check (rating in ('met', 'partial', 'not_met')),
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index work_with_session_observations_parent_ordinal_key on work_with_session_observations (work_with_session_id, ordinal);
create trigger work_with_session_observations_set_updated_at before update on work_with_session_observations for each row execute function set_updated_at();

-- perDiemValidations
create table per_diem_validations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  profile_id uuid not null,
  org_unit_id uuid not null,
  local_month text not null check (local_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  period_from date not null,
  period_to date not null,
  decision text not null check (decision in ('validated', 'returned')),
  note text,
  content_hash text not null,
  rule_version text not null,
  planned_stops integer not null,
  valid_calls integer not null,
  invalid_calls integer not null,
  not_visited integer not null,
  valid_days integer not null,
  valid_dates date[] default '{}' not null,
  decided_by text not null,
  decider_profile_id uuid not null,
  decided_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index per_diem_validations_profile_id_and_local_month_idx on per_diem_validations (profile_id, local_month);
create index per_diem_validations_org_unit_id_and_local_month_idx on per_diem_validations (org_unit_id, local_month);
create trigger per_diem_validations_set_updated_at before update on per_diem_validations for each row execute function set_updated_at();

-- talkSheets
create table talk_sheets (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  partner_name text not null,
  partner_key text not null,
  owner_profile_id uuid not null,
  meeting_date date not null,
  next_contact_date date,
  acknowledged_by_name text,
  status text not null check (status in ('draft', 'final')),
  previous_sheet_id uuid,
  finalized_at timestamptz,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index talk_sheets_org_unit_id_and_partner_key_and_meeting_date_idx on talk_sheets (org_unit_id, partner_key, meeting_date);
create index talk_sheets_org_unit_id_and_meeting_date_idx on talk_sheets (org_unit_id, meeting_date);
create index talk_sheets_owner_profile_id_and_meeting_date_idx on talk_sheets (owner_profile_id, meeting_date);
create trigger talk_sheets_set_updated_at before update on talk_sheets for each row execute function set_updated_at();

-- talkSheetItems
create table talk_sheet_items (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  sheet_id uuid not null,
  position integer not null,
  topic text not null check (topic in ('siv_stt', 'buying_accounts', 'program_utilization', 'report_submission', 'inventory_days', 'marketing_program', 'other_operational')),
  gap text not null,
  agreement text not null,
  corrective_action text not null,
  responsible text not null,
  timeline text not null,
  status text not null check (status in ('completed', 'on_going', 'overdue')),
  root_cause text,
  opened_on date not null,
  origin_item_id uuid,
  carried_from_item_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index talk_sheet_items_sheet_id_and_position_key on talk_sheet_items (sheet_id, position);
create trigger talk_sheet_items_set_updated_at before update on talk_sheet_items for each row execute function set_updated_at();

-- trainerForms
create table trainer_forms (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  kind text not null check (kind in ('training_program', 'training_sheet', 'job_evaluation')),
  session_id uuid not null,
  trainer_profile_id uuid not null,
  trainee_profile_id uuid not null,
  org_unit_id uuid not null,
  service_date date not null,
  status text not null check (status in ('draft', 'signed', 'acknowledged')),
  program jsonb,
  sheet jsonb,
  evaluation jsonb,
  signed_at timestamptz,
  signed_by text,
  acknowledged_at timestamptz,
  acknowledged_by text,
  trainee_comment text,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index trainer_forms_session_id_and_kind_key on trainer_forms (session_id, kind);
create index trainer_forms_trainer_profile_id_and_service_date_idx on trainer_forms (trainer_profile_id, service_date);
create index trainer_forms_trainee_profile_id_and_service_date_idx on trainer_forms (trainee_profile_id, service_date);
create index trainer_forms_org_unit_id_and_service_date_idx on trainer_forms (org_unit_id, service_date);
create trigger trainer_forms_set_updated_at before update on trainer_forms for each row execute function set_updated_at();

-- trainerForms (trainerForms.evaluationSessions[])
create table trainer_form_evaluation_sessions (
  id uuid primary key default gen_random_uuid(),
  trainer_form_id uuid not null,
  ordinal integer not null,
  session_id uuid not null,
  service_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index trainer_form_evaluation_sessions_parent_ordinal_key on trainer_form_evaluation_sessions (trainer_form_id, ordinal);
create trigger trainer_form_evaluation_sessions_set_updated_at before update on trainer_form_evaluation_sessions for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table work_with_sessions add constraint work_with_sessions_trainer_profile_id_fkey foreign key (trainer_profile_id) references profiles(id);
alter table work_with_sessions add constraint work_with_sessions_trainer_position_id_fkey foreign key (trainer_position_id) references positions(id);
alter table work_with_sessions add constraint work_with_sessions_trainee_profile_id_fkey foreign key (trainee_profile_id) references profiles(id);
alter table work_with_sessions add constraint work_with_sessions_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table work_with_session_observations add constraint work_with_session_observations_work_with_session_id_fkey foreign key (work_with_session_id) references work_with_sessions(id) on delete cascade;
alter table per_diem_validations add constraint per_diem_validations_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table per_diem_validations add constraint per_diem_validations_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table per_diem_validations add constraint per_diem_validations_decider_profile_id_fkey foreign key (decider_profile_id) references profiles(id);
alter table talk_sheets add constraint talk_sheets_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table talk_sheets add constraint talk_sheets_owner_profile_id_fkey foreign key (owner_profile_id) references profiles(id);
alter table talk_sheets add constraint talk_sheets_previous_sheet_id_fkey foreign key (previous_sheet_id) references talk_sheets(id);
alter table talk_sheet_items add constraint talk_sheet_items_sheet_id_fkey foreign key (sheet_id) references talk_sheets(id);
alter table talk_sheet_items add constraint talk_sheet_items_origin_item_id_fkey foreign key (origin_item_id) references talk_sheet_items(id);
alter table talk_sheet_items add constraint talk_sheet_items_carried_from_item_id_fkey foreign key (carried_from_item_id) references talk_sheet_items(id);
alter table trainer_forms add constraint trainer_forms_session_id_fkey foreign key (session_id) references work_with_sessions(id);
alter table trainer_forms add constraint trainer_forms_trainer_profile_id_fkey foreign key (trainer_profile_id) references profiles(id);
alter table trainer_forms add constraint trainer_forms_trainee_profile_id_fkey foreign key (trainee_profile_id) references profiles(id);
alter table trainer_forms add constraint trainer_forms_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table trainer_form_evaluation_sessions add constraint trainer_form_evaluation_sessions_trainer_form_id_fkey foreign key (trainer_form_id) references trainer_forms(id) on delete cascade;
alter table trainer_form_evaluation_sessions add constraint trainer_form_evaluation_sessions_session_id_fkey foreign key (session_id) references work_with_sessions(id);

-- Supporting indexes for foreign keys without a leading index.
create index work_with_sessions_trainer_position_id_fk_idx on work_with_sessions (trainer_position_id);
create index per_diem_validations_decider_profile_id_fk_idx on per_diem_validations (decider_profile_id);
create index talk_sheets_previous_sheet_id_fk_idx on talk_sheets (previous_sheet_id);
create index talk_sheet_items_origin_item_id_fk_idx on talk_sheet_items (origin_item_id);
create index talk_sheet_items_carried_from_item_id_fk_idx on talk_sheet_items (carried_from_item_id);
create index trainer_form_evaluation_sessions_session_id_fk_idx on trainer_form_evaluation_sessions (session_id);
