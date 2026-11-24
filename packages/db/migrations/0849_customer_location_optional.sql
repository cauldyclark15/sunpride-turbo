-- SP-0243: a genuine customer capture can arrive without a location.
-- No placeholder pins: the office can finish the location later.
alter table outlet_enrolments alter column pin_id drop not null;
alter table outlet_enrolments add column if not exists location_evidence jsonb;

alter table census_captures drop constraint if exists census_captures_accuracy_meters_check;
alter table census_captures add constraint census_captures_accuracy_meters_check
  check (accuracy_meters > 0 and accuracy_meters <= 500);

alter table census_captures drop constraint if exists census_captures_new_complete_ck;
alter table census_captures add constraint census_captures_new_complete_ck check (
  kind = 'change' or (channel_id is not null and subchannel_id is not null
    and estimated_class is not null and photo_file_id is not null)
);
alter table census_captures drop constraint if exists census_captures_source_accuracy_ck;
alter table census_captures add constraint census_captures_source_accuracy_ck check (
  (location_source = 'gps' and ((latitude is null and accuracy_meters is null)
    or (latitude is not null and accuracy_meters is not null)))
  or (location_source = 'places' and latitude is not null and place_id is not null)
);
-- census_captures_point_ck still enforces both coordinates present or both absent.
-- Rollback requires resolving location-less captures/enrolments first; do not fabricate pins.
