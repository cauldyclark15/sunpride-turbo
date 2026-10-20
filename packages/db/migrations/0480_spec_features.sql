-- v2 spec PROGRAMME (F-025 traceability): Sunpride's Phase 1 feature list, waves and our status.
-- Read-only on the web; rows change only through packages/db/seed/programme.js (idempotent upsert).

create table spec_waves (
  code text primary key,
  name text not null,
  months text not null,
  go_no_go_owner text not null,
  exit_criteria jsonb not null default '[]'::jsonb check (jsonb_typeof(exit_criteria) = 'array'),
  sort integer not null,
  updated_at timestamptz not null default now()
);

create table spec_features (
  feature_id text primary key check (feature_id ~ '^F-(R0[1-8]|[0-9]{3})$'),
  wave_code text not null references spec_waves(code),
  name text not null,
  description text not null,
  block_id text not null,
  block_name text not null,
  layer text not null,
  module text not null,
  moscow text not null,
  complexity text not null,
  depends_on text not null,
  block_role text not null,
  status text not null check (status in (
    'built','partly_built','changing_to_spec','not_built','needs_sunpride','conditional')),
  now_note text not null,
  next_note text not null,
  lane_when text not null,
  deferral_pool boolean not null default false,
  sort integer not null,
  updated_at timestamptz not null default now()
);

create index spec_features_wave_block_idx on spec_features(wave_code, block_id, sort);
