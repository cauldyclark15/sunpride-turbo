-- F-006 F-107: one versioned engine shared by every channel and native shell.
create extension if not exists btree_gist;
create table call_flow_definitions (
  id uuid primary key default gen_random_uuid(),
  channel_profile text not null,
  version integer not null check(version > 0),
  label text not null,
  steps jsonb not null check(jsonb_typeof(steps)='array'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  published_by text not null,
  source text not null default 'office',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(channel_profile,version),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(channel_profile with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
-- F-106 F-207: policies are local execution controls, never SAP financial authority.
create table call_flow_policies (
  id uuid primary key default gen_random_uuid(), channel_profile text not null,
  outlet_class text not null default '*', version integer not null check(version>0),
  radius_meters integer not null check(radius_meters between 1 and 500),
  max_accuracy_meters integer not null check(max_accuracy_meters between 1 and 100),
  max_fix_age_ms integer not null check(max_fix_age_ms between 1000 and 300000),
  min_dwell_ms integer not null check(min_dwell_ms between 0 and 14400000),
  effective_from timestamptz not null, effective_to timestamptz,
  published_by text not null, source text not null default 'office',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(channel_profile,outlet_class,version),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(channel_profile with =,outlet_class with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
-- F-120: versioned controlled no-order list. Other exception reasons retain the authored text.
create table no_order_reasons (
  id uuid primary key default gen_random_uuid(), code text not null, label text not null,
  version integer not null check(version>0), effective_from timestamptz not null, effective_to timestamptz,
  published_by text not null, source text not null default 'office',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(code,version), check(effective_to is null or effective_to>effective_from),
  exclude using gist(code with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create table call_executions (
  id uuid primary key default gen_random_uuid(), organization_id text not null default 'sunpride',
  client_call_id uuid not null, profile_id uuid not null references profiles(id),
  device_id uuid not null references registered_devices(id), org_unit_id uuid not null references org_units(id),
  outlet_id uuid not null references outlets(id), visit_id uuid unique references visit_executions(id),
  trip_id uuid references van_trips(id), service_date date not null,
  definition_id uuid not null references call_flow_definitions(id), definition_snapshot jsonb not null,
  policy_snapshot jsonb not null, reasons_snapshot jsonb not null,
  planned_visit_id uuid references planned_visits(id), planned_sequence integer,
  source text not null check(source in ('planned','deviated','unplanned')),
  deviation_reason text, unplanned_reason text,
  state text not null default 'open' check(state in ('open','closed')),
  started_at timestamptz not null, ended_at timestamptz,
  zero_sale_reason jsonb, short_call_reason text, duration_ms bigint,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(profile_id,device_id,client_call_id)
);
create unique index callflow_one_open on call_executions(profile_id) where state='open';
create index callflow_day on call_executions(profile_id,service_date);
create table call_step_events (
  id uuid primary key default gen_random_uuid(), call_id uuid not null references call_executions(id),
  step_key text not null, adapter text not null, operation_key uuid not null,
  entity_id text, facts jsonb not null default '{}'::jsonb, device_time timestamptz not null, actor_subject text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(call_id,step_key,operation_key)
);
-- F-106: approval precedes an outside-radius start, bound to person/device/store/policy/event.
create table call_flow_reviews (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references profiles(id),
  device_id uuid not null references registered_devices(id), org_unit_id uuid not null references org_units(id),
  outlet_id uuid not null references outlets(id), call_id uuid references call_executions(id),
  kind text not null check(kind in ('geofence_start','geofence_end','short_call','sequence','unplanned')),
  policy_id uuid references call_flow_policies(id), reason text not null,
  expires_at timestamptz, consumed_by uuid references call_executions(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table call_flow_decisions (
  id uuid primary key default gen_random_uuid(), review_id uuid not null unique references call_flow_reviews(id),
  decision text not null check(decision in ('approve','reject')), reason text not null,
  actor_profile_id uuid not null references profiles(id), actor_subject text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create function callflow_append_only() returns trigger language plpgsql as $$
begin raise exception 'callflow append-only record'; end; $$;
create trigger callflow_step_immutable before update or delete on call_step_events for each row execute function callflow_append_only();
create trigger callflow_decision_immutable before update or delete on call_flow_decisions for each row execute function callflow_append_only();
create function callflow_version_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-'effective_to'-'updated_at') is distinct from (to_jsonb(old)-'effective_to'-'updated_at')
    then raise exception 'publish a new callflow version'; end if;
  return new;
end; $$;
create trigger callflow_definition_guard before update on call_flow_definitions for each row execute function callflow_version_guard();
create trigger callflow_policy_guard before update on call_flow_policies for each row execute function callflow_version_guard();
create trigger callflow_reason_guard before update on no_order_reasons for each row execute function callflow_version_guard();
