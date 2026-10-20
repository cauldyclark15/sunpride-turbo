-- F-322: retain cancelled scheduled grants as empty, auditable intervals.
-- No rows are deleted. The existing GiST exclusion already treats [t,t) as empty.
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid='partner_outlet_assignments'::regclass
    and contype='c' and pg_get_constraintdef(oid) like '%effective_to%'
  loop
    execute format('alter table partner_outlet_assignments drop constraint %I',c.conname);
  end loop;
end $$;
alter table partner_outlet_assignments add constraint partner_outlet_effective_window
  check(effective_to is null or effective_to >= effective_from);
