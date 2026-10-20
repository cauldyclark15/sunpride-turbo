-- F-003: only seed-owned, transaction-created sample trace rows can leave with the explicit sample reset.
-- Normal trace UPDATE/DELETE, conflicts and unowned operator actions remain append-only.
create or replace function integration_append_only() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' and TG_TABLE_NAME='integration_resolution_events'
    and current_setting('sunpride.seed_reset',true)='sunpride-demo-v2'
    and exists(select 1 from sample_data_rows where batch='sunpride-demo-v2' and table_name=TG_TABLE_NAME and row_id=old.id::text)
    and exists(select 1 from sample_data_rows where batch='sunpride-demo-v2' and table_name='integration_events' and row_id=old.event_id::text)
  then return old; end if;
  raise exception 'integration trace is append only';
end $$;
