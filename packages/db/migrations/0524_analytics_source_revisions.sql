-- F-601 bounded revision verification for the existing p95 contract.
-- Source writers never touch cached money. Per-day revisions invalidate the projection.
create table analytics_source_versions (
 service_date date primary key,revision bigint not null default 0,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
alter table analytics_refresh_state add column source_version bigint;
create function analytics_touch_source_day(day date) returns void language sql as $$
 insert into analytics_source_versions(service_date,revision) values(day,1)
 on conflict(service_date) do update set revision=analytics_source_versions.revision+1,updated_at=now()
$$;
create function analytics_source_revision_trigger() returns trigger language plpgsql as $$
declare old_day date; new_day date;
begin
 if tg_table_name='orders' then
  if tg_op<>'INSERT' then old_day=coalesce(old.service_date,(coalesce(old.offline_created_at,old.created_at) at time zone 'Asia/Manila')::date); end if;
  if tg_op<>'DELETE' then new_day=coalesce(new.service_date,(coalesce(new.offline_created_at,new.created_at) at time zone 'Asia/Manila')::date); end if;
 else
  if tg_op<>'INSERT' then select coalesce(o.service_date,(coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date) into old_day from orders o where o.id=old.order_id; end if;
  if tg_op<>'DELETE' then select coalesce(o.service_date,(coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date) into new_day from orders o where o.id=new.order_id; end if;
 end if;
 -- Stable date order prevents A→B / B→A date corrections from taking opposite locks.
 if old_day is not null and new_day is not null and old_day<>new_day then
  perform analytics_touch_source_day(least(old_day,new_day));perform analytics_touch_source_day(greatest(old_day,new_day));
 elsif coalesce(new_day,old_day) is not null then perform analytics_touch_source_day(coalesce(new_day,old_day)); end if;
 return null;
end $$;
create trigger analytics_orders_revision after insert or update or delete on orders for each row execute function analytics_source_revision_trigger();
create trigger analytics_lines_revision after insert or update or delete on order_lines for each row execute function analytics_source_revision_trigger();
insert into analytics_source_versions(service_date,revision)
 select distinct coalesce(service_date,(coalesce(offline_created_at,created_at) at time zone 'Asia/Manila')::date),1 from orders;
