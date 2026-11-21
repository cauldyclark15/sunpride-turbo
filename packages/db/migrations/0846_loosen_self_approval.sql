-- Loosen rules (jc): the same person may prepare and approve a target cascade or publish a
-- territory scenario. Drop the database-level "different person" checks; keep every other
-- part of the territory scenario publish check.
do $$
declare c record;
begin
  for c in
    select conrelid::regclass::text as tbl, conname
    from pg_constraint
    where contype = 'c'
      and conrelid::regclass::text in ('target_cascades', 'territory_scenarios')
      and pg_get_constraintdef(oid) ~ '<> prepared_by'
  loop
    execute format('alter table %I drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table territory_scenarios
  add constraint territory_scenarios_published_facts
  check (status <> 'published' or (published_by is not null and assignment_ids is not null));
