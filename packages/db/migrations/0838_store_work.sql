-- SP-0225: reusable store work; approved plans keep their own named snapshot.
create table store_activity_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 200),
  active boolean not null default true,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
create unique index store_activity_name on store_activity_definitions(lower(name));
create table store_work_routines (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 200),
  activity_ids uuid[] not null check (cardinality(activity_ids) between 1 and 50),
  active boolean not null default true,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
create unique index store_routine_name on store_work_routines(lower(name));
alter table coverage_plan_slots add column store_work jsonb not null default '{"activities":[]}';
alter table visit_activities drop constraint visit_activities_activity_kind_check;
alter table visit_activities add constraint visit_activities_activity_kind_check
  check (activity_kind in ('inventory_check','merchandising','price_check','promotion','order_intent','note','call_sheet','planned_activity'));
