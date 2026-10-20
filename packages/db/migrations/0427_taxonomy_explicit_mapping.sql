-- F-013/F-022: explicit governed identities supplied by census/import/SAP writers
-- must survive INSERT. Only a legacy-only change remaps its compatibility projection.
-- Original source keys are retained; inactive dictionary entries are not newly assigned.
create or replace function masters_map_source_channel() returns trigger language plpgsql as $$
declare alias master_channel_aliases; explicit_ids boolean;
begin
  if tg_op='INSERT' then
    if new.channel_id is not null then return new; end if;
    if tg_table_name='outlets' then
      if new.subchannel_id is not null then return new; end if;
    end if;
  else
    if new.channel is not distinct from old.channel then return new; end if;
    explicit_ids:=new.channel_id is distinct from old.channel_id;
    if tg_table_name='outlets' then explicit_ids:=explicit_ids or new.subchannel_id is distinct from old.subchannel_id; end if;
    if explicit_ids then return new; end if;
  end if;
  select a.* into alias from master_channel_aliases a
    where lower(a.legacy_key)=lower(new.channel)
    and exists(select 1 from master_versions v where v.master_id=a.channel_id and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now()))
    and (a.subchannel_id is null or exists(select 1 from master_versions v where v.master_id=a.subchannel_id and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now()) and v.data->>'channelId'=a.channel_id::text));
  new.channel_id:=alias.channel_id;
  if tg_table_name='outlets' then new.subchannel_id:=alias.subchannel_id; end if;
  return new;
end $$;
