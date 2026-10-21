-- F-R02: a Z closes a register's Manila day, not just its last cashier shift.
create unique index store_one_z_day on store_reads(register_id,((snapshot->>'date'))) where kind='z';
-- F-R04: an explicit subset belongs to the canonical count snapshot, not a second count engine.
alter table stock_count_sessions add column cycle_product_ids jsonb;
