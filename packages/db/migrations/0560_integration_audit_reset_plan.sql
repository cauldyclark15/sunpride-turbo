-- F-020 F-025: keep the exact reset ownership fence while binding trigger variables
-- as text/uuid parameters. The implicit trigger-name expression prevented an index
-- probe in the per-row guard, making a full marked reset quadratic in row count.
create or replace function fiscal_guard_audit() returns trigger language plpgsql as $$
declare owned boolean;
begin
  if tg_op='DELETE' and current_setting('sunpride.seed_reset',true)='sunpride-demo-v2'
     and to_regclass('pg_temp.seed_owned_reset') is not null then
    execute 'select exists(select 1 from pg_temp.seed_owned_reset where table_name=$1 and row_id=$2)'
      into owned using tg_table_name::text,old.id;
    if owned then return old; end if;
  end if;
  raise exception 'Audit is append-only';
end; $$;
