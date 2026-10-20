-- F-007: one active device per person ACROSS apps. Quarantine pre-existing conflicts;
-- never delete their receipts, evidence or queued work. Admin reconciles before handover.
insert into audit_logs(subject,action,entity_type,entity_id,details)
select 'migration:0470','device.cross_app_conflict','device',id,
       '{"reason":"F-007","queuedWork":"hold_for_review"}'::jsonb
from registered_devices where status='active' and profile_id in
(select profile_id from registered_devices where status='active' group by profile_id having count(*)>1);
update registered_devices set status='suspended' where status='active' and profile_id in
(select profile_id from registered_devices where status='active' group by profile_id having count(*)>1);
create unique index registered_devices_one_person_active_uq on registered_devices(profile_id) where status='active';

-- F-007: explicitly linked federated identities; email equality alone never links accounts.
create table identity_providers (
  id uuid primary key default gen_random_uuid(), code text not null, label text not null,
  issuer text not null, client_id text not null, redirect_uri text not null,
  effective_from timestamptz not null, effective_to timestamptz,
  source_ref text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(code,effective_from), check(effective_to is null or effective_to>effective_from)
);
create table federated_identities (
  id uuid primary key default gen_random_uuid(), issuer text not null, subject text not null,
  user_id uuid not null references users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(issuer,subject)
);
create table oidc_requests (
  id uuid primary key default gen_random_uuid(), state_hash text not null unique,
  provider_id uuid not null references identity_providers(id), nonce text not null, verifier text not null,
  expires_at timestamptz not null, consumed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table device_controls (
  id uuid primary key default gen_random_uuid(), device_id uuid not null references registered_devices(id),
  kind text not null check(kind in ('wipe','handover')), requested_by uuid not null references users(id),
  reason_code text not null, status text not null default 'pending' check(status in ('pending','acknowledged')),
  queued_count integer, queue_digest text, recovery_blob_id uuid references files(id),
  acknowledged_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index device_controls_pending_uq on device_controls(device_id) where status='pending';
create table device_handovers (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null,
  from_device_id uuid not null references registered_devices(id), to_app text not null,
  public_key_spki text not null, key_id text not null, inventory_tag text not null,
  requested_by uuid not null references users(id), control_id uuid not null references device_controls(id),
  status text not null default 'reconciling' check(status in ('reconciling','completed')),
  reconciliation text, completed_by uuid references users(id), completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- F-021: effective-dated fleet records; peripheral/MDM/connectivity/spares/break-fix facts.
create table fleet_asset_versions (
  id uuid primary key default gen_random_uuid(), asset_tag text not null, org_unit_id uuid not null,
  device_id uuid references registered_devices(id), assigned_profile_id uuid,
  model text not null, state text not null check(state in ('assigned','spare','repair','retired')),
  peripherals jsonb not null default '[]', mdm_status text not null check(mdm_status in ('unknown','enrolled','compliant','noncompliant','lost')),
  mdm_source text not null, mdm_observed_at timestamptz,
  data_plan text not null, break_fix_due_at timestamptz, note text not null default '',
  effective_from timestamptz not null, effective_to timestamptz, source_ref text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(asset_tag,effective_from), check(effective_to is null or effective_to>effective_from)
);
create index fleet_asset_versions_current_idx on fleet_asset_versions(asset_tag,effective_from desc);

-- F-024/F-221/F-606: versioned policy, immutable observations/findings and append-only decisions.
create table integrity_policy_versions (
  id uuid primary key default gen_random_uuid(), code text not null, settings jsonb not null,
  effective_from timestamptz not null, effective_to timestamptz, source_ref text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(code,effective_from), check(effective_to is null or effective_to>effective_from)
);
insert into integrity_policy_versions(code,settings,effective_from,source_ref) values
('field-integrity','{"maxTravelKph":160,"travelToleranceMeters":200,"photoTimeToleranceMs":120000,"photoGpsToleranceMeters":200,"perceptualHamming":6,"batchWindowMs":60000,"batchCount":5,"discountRatePct":20,"returnRatioPct":30,"settlementVarianceCentavos":10000,"orderRepeatCount":3,"mockExitRatePct":0.5}', '2020-01-01','SAMPLE: provisional F-024/F-221/F-606 defaults');
create table device_integrity_assessments (
  id uuid primary key default gen_random_uuid(), device_id uuid not null references registered_devices(id),
  rooted boolean not null, tampered boolean not null, source text not null,
  observed_at timestamptz not null, expires_at timestamptz not null, evidence jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index device_integrity_assessments_latest_idx on device_integrity_assessments(device_id,observed_at desc);
create table device_integrity_exceptions (
  id uuid primary key default gen_random_uuid(), device_id uuid not null references registered_devices(id),
  approved_by uuid not null references users(id), reason_code text not null,
  effective_from timestamptz not null, effective_to timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check(effective_to>effective_from)
);
create table integrity_observations (
  id uuid primary key default gen_random_uuid(), source_key text not null unique, kind text not null,
  profile_id uuid not null, org_unit_id uuid not null, device_id uuid references registered_devices(id), outlet_id uuid,
  occurred_at timestamptz not null, facts jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index integrity_observations_person_idx on integrity_observations(profile_id,occurred_at);
create table integrity_runs (
  id uuid primary key default gen_random_uuid(), policy_id uuid not null references integrity_policy_versions(id),
  scanned integer not null default 0, findings integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table integrity_findings (
  id uuid primary key default gen_random_uuid(), rule text not null, source_key text not null,
  policy_id uuid not null references integrity_policy_versions(id), run_id uuid references integrity_runs(id),
  profile_id uuid not null, org_unit_id uuid not null, device_id uuid, outlet_id uuid,
  evidence jsonb not null, severity text not null check(severity in ('high','medium','low')),
  occurred_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(rule,source_key,policy_id)
);
create table integrity_dispositions (
  id uuid primary key default gen_random_uuid(), finding_id uuid not null references integrity_findings(id),
  decided_by uuid not null references users(id), outcome text not null check(outcome in ('confirmed','false_positive','needs_evidence')),
  reason_code text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index integrity_findings_queue_idx on integrity_findings(org_unit_id,created_at,id);
create function integrity_immutable() returns trigger language plpgsql as $$ begin
  raise exception 'Integrity evidence and decisions are append-only'; end; $$;
create trigger integrity_observations_immutable before update or delete on integrity_observations for each row execute function integrity_immutable();
create trigger integrity_findings_immutable before update or delete on integrity_findings for each row execute function integrity_immutable();
create trigger integrity_dispositions_immutable before update or delete on integrity_dispositions for each row execute function integrity_immutable();

-- F-312: structured provenance is additive; original JPEG/hash stay authoritative.
alter table field_evidence_files add column capture_manifest jsonb;
create table photo_integrity_facts (
  id uuid primary key default gen_random_uuid(), file_id uuid not null unique references files(id),
  org_unit_id uuid not null, profile_id uuid not null, outlet_id uuid,
  manifest jsonb not null, exif jsonb not null, perceptual_hash text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger photo_integrity_facts_immutable before update or delete on photo_integrity_facts for each row execute function integrity_immutable();
