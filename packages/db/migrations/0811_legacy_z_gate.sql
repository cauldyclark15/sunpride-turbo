-- IP-SCPWD-CAP: switch for the legacy "Z reading with no supervisor PIN" path, and the app build each phone reports.
--
-- Phones on beta.26-29 send the Z reading without a supervisor PIN. The server still accepts that (those phones cannot do
-- anything else). Builds from beta.30 can sign the Z with a PIN, so for them the no-PIN path is a bypass: the gate refuses it.
-- Phones now report their build in the `x-app-version-code` header (beta.N has version code N); a phone that has never
-- reported shows as "unknown", and one that has ever sent a PIN-approved override or Z counts as PIN-capable.

-- 1. What the phone last said it is running.
alter table registered_devices
  add column app_version_code integer check (app_version_code is null or app_version_code between 1 and 999999),
  add column app_version_name text check (app_version_name is null or length(app_version_name) <= 40),
  add column app_version_seen_at timestamptz;

-- 2. The gate. Newest row wins; no row = mode 'older_builds_only' with the first PIN-capable build 30.
--    older_builds_only: refuse the no-PIN Z from a phone known to be on that build or later, or known to sign with a PIN.
--    off:               refuse the no-PIN Z from every phone (the office switches this on when the report shows nothing is left).
create table legacy_z_gate_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  mode text not null check (mode in ('older_builds_only','off')),
  min_version_code integer not null check (min_version_code between 1 and 999999),
  note text,
  effective_from timestamptz not null default now(),
  set_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);
create index legacy_z_gate_lookup on legacy_z_gate_settings(organization_id, effective_from desc, created_at desc);
create trigger legacy_z_gate_settings_immutable before update or delete on legacy_z_gate_settings
  for each row execute function fiscal_immutable();
