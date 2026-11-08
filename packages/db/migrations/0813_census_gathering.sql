-- SP-0162 customer gathering: address-search location source, address parts, landmark,
-- duplicate evidence on each capture, per-unit ongoing batch, and Google place ids on stores.
-- Re-runnable (IF NOT EXISTS everywhere). Index builds take a brief SHARE lock on
-- census_captures/outlets (~300 outlets live): deploy off-peak. Rollback at the bottom.
alter table census_captures add column if not exists location_source text not null default 'gps'
  check (location_source in ('gps', 'places'));
alter table census_captures add column if not exists place_id text;
alter table census_captures add column if not exists address_components jsonb;
alter table census_captures add column if not exists formatted_address text;
alter table census_captures add column if not exists landmark text;
alter table census_captures add column if not exists acknowledged_duplicate_ids jsonb not null default '[]'::jsonb;
alter table census_captures add column if not exists duplicate_candidates jsonb not null default '[]'::jsonb;
alter table census_captures add column if not exists duplicate_flag boolean not null default false;
alter table census_captures add column if not exists app text;
-- Address-search captures have no GPS accuracy; GPS captures keep the under-50 m rule.
alter table census_captures alter column accuracy_meters drop not null;
alter table census_captures drop constraint if exists census_captures_source_accuracy_ck;
alter table census_captures add constraint census_captures_source_accuracy_ck check (
  (location_source = 'gps' and accuracy_meters is not null)
  or (location_source = 'places' and place_id is not null)
);
create index if not exists census_captures_place_id_idx on census_captures (place_id) where place_id is not null;
create index if not exists census_captures_lat_lng_idx on census_captures (latitude, longitude);

alter table census_batches add column if not exists is_default boolean not null default false;
create unique index if not exists census_batches_one_default_per_unit on census_batches (org_unit_id) where is_default;

alter table outlets add column if not exists place_id text;
create index if not exists outlets_place_id_idx on outlets (place_id) where place_id is not null;

-- Address-search places are checked against Google by a background job after sync, never
-- inside the sync op. Captures stay append-only and keep the phone's point; the check result
-- is its own append-only row. No row = still checking. 'verified' = within 50 m (Google's
-- point is the store pin). 'mismatch' = over 50 m or the place is gone: the reviewer must
-- confirm which pin is right before approving.
create table if not exists census_place_checks (
  capture_id uuid primary key references census_captures(id),
  status text not null check (status in ('verified', 'mismatch')),
  place_latitude double precision check (place_latitude between -90 and 90),
  place_longitude double precision check (place_longitude between -180 and 180),
  distance_meters double precision,
  checked_at timestamptz not null default now(),
  check ((place_latitude is null) = (place_longitude is null)),
  check (status = 'mismatch' or place_latitude is not null)
);
drop trigger if exists census_place_checks_immutable on census_place_checks;
create trigger census_place_checks_immutable before update or delete on census_place_checks
  for each row execute function masters_immutable();

-- ROLLBACK (manual). accuracy_meters stays nullable once any address-search capture exists.
--   drop table if exists census_place_checks;
--   drop index if exists outlets_place_id_idx;
--   alter table outlets drop column if exists place_id;
--   drop index if exists census_batches_one_default_per_unit;
--   alter table census_batches drop column if exists is_default;
--   drop index if exists census_captures_lat_lng_idx;
--   drop index if exists census_captures_place_id_idx;
--   alter table census_captures drop constraint if exists census_captures_source_accuracy_ck;
--   alter table census_captures
--     drop column if exists app,
--     drop column if exists duplicate_flag, drop column if exists duplicate_candidates,
--     drop column if exists acknowledged_duplicate_ids, drop column if exists landmark,
--     drop column if exists formatted_address, drop column if exists address_components,
--     drop column if exists place_id, drop column if exists location_source;
--   delete from schema_migrations where name = '0813_census_gathering.sql';
