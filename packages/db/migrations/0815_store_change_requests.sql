-- Field "Edit store": a store change request rides the store-gathering capture table as
-- kind='change', linked to the existing store (target_outlet_id). The office approves it in
-- the same review (census_reviews, append-only); Approve updates that store, never inserts one.
-- Additive: new columns default to the old meaning (kind='new'); change rows may leave the
-- fields they do not touch empty (channel, class, photo, location), new rows still need them.
-- Re-runnable. Rollback at the bottom.
alter table census_captures add column if not exists kind text not null default 'new'
  check (kind in ('new', 'change'));
alter table census_captures add column if not exists target_outlet_id uuid references outlets(id);
-- What the store looked like when the change was proposed (old side of old -> new).
alter table census_captures add column if not exists previous_values jsonb;
alter table census_captures drop constraint if exists census_captures_kind_target_ck;
alter table census_captures add constraint census_captures_kind_target_ck
  check ((kind = 'change') = (target_outlet_id is not null));

alter table census_captures alter column latitude drop not null;
alter table census_captures alter column longitude drop not null;
alter table census_captures alter column channel_id drop not null;
alter table census_captures alter column subchannel_id drop not null;
alter table census_captures alter column estimated_class drop not null;
alter table census_captures alter column photo_file_id drop not null;
alter table census_captures drop constraint if exists census_captures_new_complete_ck;
alter table census_captures add constraint census_captures_new_complete_ck check (
  kind = 'change' or (latitude is not null and longitude is not null and channel_id is not null
    and subchannel_id is not null and estimated_class is not null and photo_file_id is not null)
);
alter table census_captures drop constraint if exists census_captures_point_ck;
alter table census_captures add constraint census_captures_point_ck
  check ((latitude is null) = (longitude is null));
-- A change with no new location carries no location evidence at all.
alter table census_captures drop constraint if exists census_captures_source_accuracy_ck;
alter table census_captures add constraint census_captures_source_accuracy_ck check (
  (kind = 'change' and latitude is null)
  or (location_source = 'gps' and accuracy_meters is not null)
  or (location_source = 'places' and place_id is not null)
);
create index if not exists census_captures_target_outlet_idx on census_captures (target_outlet_id)
  where target_outlet_id is not null;

-- ROLLBACK (manual; only while no change rows exist):
--   delete from census_captures where kind = 'change';  -- blocked by the append-only trigger; drop it first
--   drop index if exists census_captures_target_outlet_idx;
--   alter table census_captures drop constraint if exists census_captures_point_ck;
--   alter table census_captures drop constraint if exists census_captures_new_complete_ck;
--   alter table census_captures drop constraint if exists census_captures_kind_target_ck;
--   alter table census_captures drop constraint census_captures_source_accuracy_ck;
--   alter table census_captures add constraint census_captures_source_accuracy_ck check (
--     (location_source = 'gps' and accuracy_meters is not null)
--     or (location_source = 'places' and place_id is not null));
--   alter table census_captures alter column latitude set not null, alter column longitude set not null,
--     alter column channel_id set not null, alter column subchannel_id set not null,
--     alter column estimated_class set not null, alter column photo_file_id set not null;
--   alter table census_captures drop column if exists previous_values,
--     drop column if exists target_outlet_id, drop column if exists kind;
--   delete from schema_migrations where name = '0815_store_change_requests.sql';
