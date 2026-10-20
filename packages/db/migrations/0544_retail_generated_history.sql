-- F-311 F-314 F-320: PostgreSQL computes generated FK columns after BEFORE triggers.
-- Compare stored authority fields, not the not-yet-generated NEW values.
create or replace function retail_master_immutable() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then
    if current_setting('sunpride.seed_reset',true)='sunpride-demo-v2' and exists (
      select 1 from sample_data_rows where table_name=TG_TABLE_NAME and row_id=old.id::text and batch='sunpride-demo-v2'
    ) then return old; end if;
    raise exception 'Retail master history is immutable';
  end if;
  if (to_jsonb(new)-array['effective_to','updated_at','equipment_outlet_id','equipment_policy_id','expiry_product_id'])
    is distinct from (to_jsonb(old)-array['effective_to','updated_at','equipment_outlet_id','equipment_policy_id','expiry_product_id'])
    or new.effective_to is null
    or new.effective_to<=old.effective_from
    or (old.effective_to is not null and new.effective_to>old.effective_to) then
    raise exception 'Publish a new retail master version';
  end if;
  return new;
end $$;
