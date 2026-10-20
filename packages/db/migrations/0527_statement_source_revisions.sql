-- F-601: bounded source invalidation once per changed date/statement rather than
-- per invoice line. Preserve the event-day rule and both sides of a correction.
-- Existing row functions remain for rollback; no business table/column/data is removed.
create function analytics_source_revision_statement() returns trigger language plpgsql as $$
declare rows_sql text; days_sql text; day date;
begin
 if tg_op='INSERT' then rows_sql='select * from new_source_rows';
 elsif tg_op='DELETE' then rows_sql='select * from old_source_rows';
 else rows_sql='select * from old_source_rows union all select * from new_source_rows'; end if;
 if tg_table_name='orders' then
  days_sql=format('select distinct coalesce(service_date,(coalesce(offline_created_at,created_at) at time zone ''Asia/Manila'')::date) as source_day from (%s) changed order by 1',rows_sql);
 elsif tg_table_name='order_lines' then
  days_sql=format('select distinct coalesce(o.service_date,(coalesce(o.offline_created_at,o.created_at) at time zone ''Asia/Manila'')::date) as source_day from orders o join (select distinct order_id from (%s) changed) ids on ids.order_id=o.id order by 1',rows_sql);
 else raise exception 'Unsupported analytics source table'; end if;
 for day in execute days_sql loop
  if day is not null then perform analytics_touch_source_day(day); end if;
 end loop;
 return null;
end $$;
drop trigger analytics_orders_revision on orders;
drop trigger analytics_lines_revision on order_lines;
create trigger analytics_orders_revision_insert after insert on orders referencing new table as new_source_rows for each statement execute function analytics_source_revision_statement();
create trigger analytics_orders_revision_update after update on orders referencing old table as old_source_rows new table as new_source_rows for each statement execute function analytics_source_revision_statement();
create trigger analytics_orders_revision_delete after delete on orders referencing old table as old_source_rows for each statement execute function analytics_source_revision_statement();
create trigger analytics_lines_revision_insert after insert on order_lines referencing new table as new_source_rows for each statement execute function analytics_source_revision_statement();
create trigger analytics_lines_revision_update after update on order_lines referencing old table as old_source_rows new table as new_source_rows for each statement execute function analytics_source_revision_statement();
create trigger analytics_lines_revision_delete after delete on order_lines referencing old table as old_source_rows for each statement execute function analytics_source_revision_statement();
