-- F-301 F-303 F-304: freeze policies, source snapshots and photographic evidence.
alter table presell_policies add constraint presell_policy_interval exclude using gist(channel_profile with =,tstzrange(effective_from,effective_to,'[)') with &&);
create trigger presell_policy_guard before update on presell_policies for each row execute function callflow_version_guard();
create or replace function presell_immutable() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' and exists(select 1 from sample_data_rows m where m.table_name=tg_table_name and m.row_id=old.id::text and m.batch=current_setting('sunpride.seed_reset',true)) then return old; end if;
  raise exception 'Delivery evidence is immutable';
end $$;
create trigger delivery_line_immutable before update or delete on delivery_drop_lines for each row execute function presell_immutable();
create function presell_handoff_guard() returns trigger language plpgsql as $$
begin
  if new.order_id is distinct from old.order_id or new.org_unit_id is distinct from old.org_unit_id or new.outlet_id is distinct from old.outlet_id or new.snapshot is distinct from old.snapshot or new.payload_hash is distinct from old.payload_hash then raise exception 'Release snapshot is immutable'; end if;
  return new;
end $$;
create trigger presell_handoff_immutable before update on delivery_handoffs for each row execute function presell_handoff_guard();
create function presell_promise_guard() returns trigger language plpgsql as $$
begin
  if new.order_id is distinct from old.order_id or new.requested_delivery_date is distinct from old.requested_delivery_date or new.policy_id is distinct from old.policy_id or new.policy_snapshot is distinct from old.policy_snapshot or new.captured_at is distinct from old.captured_at or (old.confirmed_delivery_date is not null and (new.confirmed_delivery_date is distinct from old.confirmed_delivery_date or new.confirmed_by is distinct from old.confirmed_by or new.confirmed_at is distinct from old.confirmed_at)) then raise exception 'Captured delivery promise is immutable'; end if;
  return new;
end $$;
create trigger presell_promise_immutable before update on presell_order_promises for each row execute function presell_promise_guard();
create function presell_photo_exclusive() returns trigger language plpgsql as $$
begin
  if tg_table_name='call_step_events' then
    if new.adapter='evidence' and exists(select 1 from delivery_proofs p where p.photo_id::text=new.entity_id) then raise exception 'Photo belongs to an immutable delivery proof'; end if;
  else
    if new.damage_record_id is distinct from old.damage_record_id and exists(select 1 from delivery_proofs p where p.photo_id=old.id) then raise exception 'Photo belongs to an immutable delivery proof'; end if;
  end if;
  return new;
end $$;
create trigger presell_call_photo_exclusive before insert on call_step_events for each row execute function presell_photo_exclusive();
create trigger presell_damage_photo_exclusive before update on van_damage_photos for each row execute function presell_photo_exclusive();
