-- SP-0162 customer gathering: address-search location source, address parts, landmark,
-- duplicate evidence on each capture, per-unit ongoing batch, and Google place ids on stores.
alter table census_captures add column location_source text not null default 'gps'
  check (location_source in ('gps', 'places'));
alter table census_captures add column place_id text;
alter table census_captures add column address_components jsonb;
alter table census_captures add column formatted_address text;
alter table census_captures add column landmark text;
alter table census_captures add column acknowledged_duplicate_ids jsonb not null default '[]'::jsonb;
alter table census_captures add column duplicate_candidates jsonb not null default '[]'::jsonb;
alter table census_captures add column duplicate_flag boolean not null default false;
alter table census_captures add column app text;
-- Address-search captures have no GPS accuracy; GPS captures keep the under-50 m rule.
alter table census_captures alter column accuracy_meters drop not null;
alter table census_captures add constraint census_captures_source_accuracy_ck check (
  (location_source = 'gps' and accuracy_meters is not null)
  or (location_source = 'places' and place_id is not null)
);
create index census_captures_place_id_idx on census_captures (place_id) where place_id is not null;
create index census_captures_lat_lng_idx on census_captures (latitude, longitude);

alter table census_batches add column is_default boolean not null default false;
create unique index census_batches_one_default_per_unit on census_batches (org_unit_id) where is_default;

alter table outlets add column place_id text;
create index outlets_place_id_idx on outlets (place_id) where place_id is not null;
