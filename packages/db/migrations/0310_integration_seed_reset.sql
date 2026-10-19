-- Keep UPDATE immutable. Validate explicit demo DELETEs as one complete rowset,
-- not one ownership query per observation in a 90-day reset. Exceptions roll back
-- the whole statement/transaction; no FK or audit trigger is disabled.
create index sample_data_rows_identity_idx on sample_data_rows(table_name,row_id,batch);

create function visits_guard_deleted_observations() returns trigger language plpgsql as $$
begin
  if current_setting('sunpride.seed_reset', true) is distinct from 'sunpride-demo-v2'
     or to_regclass('pg_temp.seed_owned_reset') is null then
    raise exception 'Visit raw evidence is append-only';
  end if;
  if exists(select 1 from deleted_observations d
    left join pg_temp.seed_owned_reset m on m.table_name=tg_table_name::text and m.row_id=d.id
    where m.row_id is null) then
    raise exception 'Visit raw evidence is append-only';
  end if;
  return null;
end;
$$;

drop trigger visits_location_immutable on visit_location_evidence;
drop trigger visits_events_immutable on execution_events;
create trigger visits_location_immutable before update on visit_location_evidence
  for each row execute function visits_immutable_observation();
create trigger visits_events_immutable before update on execution_events
  for each row execute function visits_immutable_observation();
create trigger visits_location_delete_guard after delete on visit_location_evidence
  referencing old table as deleted_observations
  for each statement execute function visits_guard_deleted_observations();
create trigger visits_events_delete_guard after delete on execution_events
  referencing old table as deleted_observations
  for each statement execute function visits_guard_deleted_observations();
