-- F-009/F-013/F-017: permit only verified sample-only deletion through the existing
-- reset's exact temporary row manifest. Ordinary mutation remains append-only.
create or replace function masters_immutable() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' and current_setting('sunpride.seed_reset',true)='sunpride-demo-v2'
    and to_regclass('pg_temp.seed_owned_reset') is not null then
    if exists(select 1 from pg_temp.seed_owned_reset where table_name=tg_table_name::text and row_id=old.id) then return old; end if;
  end if;
  raise exception 'Master decision is append-only';
end $$;
create or replace function master_versions_frozen() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if current_setting('sunpride.seed_reset',true)='sunpride-demo-v2' and to_regclass('pg_temp.seed_owned_reset') is not null then
      if exists(select 1 from pg_temp.seed_owned_reset where table_name=tg_table_name::text and row_id=old.id) then return old; end if;
    end if;
    raise exception 'Master version is append-only';
  end if;
  if old.effective_to is not null or new.effective_to is null or
     (to_jsonb(new)-'effective_to') is distinct from (to_jsonb(old)-'effective_to') then raise exception 'Master version content is immutable'; end if;
  return new;
end $$;
-- Legacy channel strings remain as import provenance, never as competing canonical
-- keys. Changing a source key invalidates or remaps its canonical projection.
create function masters_map_source_channel() returns trigger language plpgsql as $$
declare alias master_channel_aliases;
begin
  if tg_op='INSERT' or new.channel is distinct from old.channel then
    select * into alias from master_channel_aliases where lower(legacy_key)=lower(new.channel);
    new.channel_id:=alias.channel_id;
    if tg_table_name='outlets' then new.subchannel_id:=alias.subchannel_id; end if;
  end if;
  return new;
end $$;
create trigger outlets_map_source_channel before insert or update of channel on outlets for each row execute function masters_map_source_channel();
create trigger customers_map_source_channel before insert or update of channel on customers for each row execute function masters_map_source_channel();
