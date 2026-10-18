-- 0113_field_reports: DAR / ROAR field day reports.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: field_day_reports.

-- fieldDayReports
create table field_day_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  profile_id uuid not null,
  org_unit_id uuid not null,
  service_date date not null,
  kind text not null check (kind in ('dar', 'roar')),
  revision integer not null,
  remarks text not null,
  summary jsonb not null,
  submitted_by text not null,
  submitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index field_day_reports_profile_id_and_service_date_and_revision_key on field_day_reports (profile_id, service_date, revision);
create trigger field_day_reports_set_updated_at before update on field_day_reports for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table field_day_reports add constraint field_day_reports_profile_id_fkey foreign key (profile_id) references profiles(id);
alter table field_day_reports add constraint field_day_reports_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);

-- Supporting indexes for foreign keys without a leading index.
create index field_day_reports_org_unit_id_fk_idx on field_day_reports (org_unit_id);
