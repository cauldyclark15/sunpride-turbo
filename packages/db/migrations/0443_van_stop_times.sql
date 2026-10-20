-- F-105 additive arrival/departure evidence; immutable observations remain the only capture store.
alter table van_trip_observations drop constraint van_trip_observations_kind_check;
alter table van_trip_observations add constraint van_trip_observations_kind_check
  check(kind in ('temperature','returnable','unload','reload_request','stop'));
create unique index van_stop_once on van_trip_observations(trip_id,(facts->>'stopId'),(facts->>'phase')) where kind='stop';
