-- F-601: a bulk source transaction invalidates a date once, not once per invoice line.
-- Avoid tens of thousands of hot-row versions during the 90-day seed/import.
alter table analytics_source_versions add column last_source_xid bigint;
create or replace function analytics_touch_source_day(day date) returns void language sql as $$
 insert into analytics_source_versions(service_date,revision,last_source_xid)
 values(day,1,txid_current())
 on conflict(service_date) do update
 set revision=analytics_source_versions.revision+1,last_source_xid=excluded.last_source_xid,updated_at=now()
 where analytics_source_versions.last_source_xid is distinct from excluded.last_source_xid
$$;
