-- F-025: operator-only tuning for the native Mac PostgreSQL 17 instance.
-- Run with psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U <operator> -d postgres -f <this file>.
-- Never run as an application migration or wrap ALTER SYSTEM in a transaction.
-- Keep fsync, full_page_writes and synchronous_commit enabled.
do $$
begin
  if current_setting('server_version_num')::int < 170000
     or current_setting('server_version_num')::int >= 180000
     or inet_server_addr() is null
     or inet_server_addr() not in ('127.0.0.1'::inet, '::1'::inet)
     or inet_server_port() <> 5432 then
    raise exception 'Native tuning requires loopback PostgreSQL 17 on port 5432';
  end if;
  if not (select rolsuper from pg_roles where rolname=current_user) then
    raise exception 'Native tuning requires the database operator, not the application role';
  end if;
end; $$;

-- A 1GB ceiling forced checkpoints 16-25 seconds apart during the 90-day fixture,
-- repeatedly emitting full-page WAL images. Leave bounded headroom for the import.
alter system set max_wal_size = '8GB';
-- On this APFS host, pg_test_fsync measured 20-22us for fdatasync versus
-- 39-81us for open_datasync. Keep synchronous WAL durability; batch the flush.
alter system set wal_sync_method = 'fdatasync';
select pg_reload_conf();

-- Run the readback again from a fresh connection after reload before acceptance.
select name,setting,unit,source,pending_restart from pg_settings
where name in ('max_wal_size','wal_sync_method','fsync','full_page_writes','synchronous_commit')
order by name;
