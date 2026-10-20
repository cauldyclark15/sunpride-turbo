-- F-221/F-606: durable keyset progress per policy version. New policies replay history safely.
create table integrity_detector_cursors (
 policy_id uuid primary key references integrity_policy_versions(id), last_created_at timestamptz not null, last_id uuid not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
