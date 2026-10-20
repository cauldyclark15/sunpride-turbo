-- F-003/F-005 retry budget is per replay; lifetime delivery attempts remain inspectable.
alter table integration_events add column total_attempts integer not null default 0;
update integration_events e set total_attempts=greatest(e.attempts,(select count(*)::integer from integration_resolution_events r where r.event_id=e.id and r.action='claimed'));

-- F-003 exact bytes and effect identity survive every operator replay.
create function guard_sap_event_identity() returns trigger language plpgsql as $$
begin
  if (new.event_id,new.direction,new.event_type,new.payload,new.payload_hash,new.schema_version,new.organization_id,new.source_type,new.source_id)
    is distinct from (old.event_id,old.direction,old.event_type,old.payload,old.payload_hash,old.schema_version,old.organization_id,old.source_type,old.source_id)
  then raise exception 'SAP effect identity and payload are immutable'; end if;
  return new;
end $$;
create trigger integration_effect_immutable before update on integration_events for each row execute function guard_sap_event_identity();

-- F-015/F-016 protect all SAP-priced child writes, not only parent edits.
create function guard_sap_price_line() returns trigger language plpgsql as $$
declare parent uuid;
begin
  if current_setting('sunpride.sap_ingest',true)='on' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then parent=old.price_list_id; else parent=new.price_list_id; end if;
  if exists(select 1 from price_lists where id=parent and source='sap') then
    raise exception 'SAP-owned prices are read only' using errcode='23514';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
create trigger price_lines_sap_readonly before insert or update or delete on price_list_lines for each row execute function guard_sap_price_line();
