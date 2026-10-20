-- F-006 F-107 F-301 F-310 F-407: later channels select a profile, never a new engine/app.
-- SEAM(MASTERS): channel_code and outlet_class use the governed outlet taxonomy keys once integrated.
create table call_flow_channel_bindings (
  id uuid primary key default gen_random_uuid(), app text not null check(app in ('field-android','van-android','field-ios')),
  channel_code text not null default '*', outlet_class text not null default '*', channel_profile text not null,
  version integer not null check(version>0), effective_from timestamptz not null, effective_to timestamptz,
  published_by text not null, source text not null default 'office',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(app,channel_code,outlet_class,version),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(app with =,channel_code with =,outlet_class with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create trigger callflow_binding_guard before update on call_flow_channel_bindings for each row execute function callflow_version_guard();
