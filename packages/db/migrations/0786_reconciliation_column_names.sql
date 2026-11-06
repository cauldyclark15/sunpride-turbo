-- IP-INT3: databases created before migration 0107 was reworded (convex_* became operational_*) still carry the old
-- column names, so the nightly integrity job (which writes operational_cutoff / operational_base) failed on them.
-- Rename in place when the old name is still there; a database made from the current 0107 is left alone.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_reconciliation_runs' and column_name = 'convex_cutoff')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_reconciliation_runs' and column_name = 'operational_cutoff') then
    alter table inventory_reconciliation_runs rename column convex_cutoff to operational_cutoff;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_reconciliation_differences' and column_name = 'convex_base')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_reconciliation_differences' and column_name = 'operational_base') then
    alter table inventory_reconciliation_differences rename column convex_base to operational_base;
  end if;
end $$;
