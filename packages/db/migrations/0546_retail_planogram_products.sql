-- F-311: preserve every SKU in an immutable layout, including non-first array entries.
-- The first-SKU FK supplies the master-before-product reset ordering; the delete guard checks all targets.
alter table retail_master_versions add column planogram_product_id uuid
  generated always as (case when kind='planogram' then (data->'lines'->0->>'productId')::uuid end) stored
  references products(id);
create index retail_planogram_product on retail_master_versions(planogram_product_id);
create function retail_planogram_sku_ids(d jsonb) returns uuid[] language sql immutable as $$
  select coalesce(array_agg((line->>'productId')::uuid),'{}'::uuid[]) from jsonb_array_elements(coalesce(d->'lines','[]'::jsonb)) line
$$;
alter table retail_master_versions add column planogram_product_ids uuid[]
  generated always as (case when kind='planogram' then retail_planogram_sku_ids(data) end) stored;
create index retail_planogram_targets on retail_master_versions using gin (planogram_product_ids) where kind='planogram';
create function retail_planogram_retain_product() returns trigger language plpgsql as $$
begin
  if exists(select 1 from retail_master_versions where kind='planogram' and planogram_product_ids @> array[old.id]) then
    raise exception 'Product is referenced by immutable retail planogram history' using errcode='23503';
  end if;
  return old;
end $$;
create trigger retail_planogram_retain_product before delete on products for each row execute function retail_planogram_retain_product();

-- PostgreSQL computes generated FK fields after BEFORE triggers; future additive generated columns are excluded too.
create or replace function retail_master_immutable() returns trigger language plpgsql as $$
declare generated_fields text[];
begin
  if TG_OP='DELETE' then
    if current_setting('sunpride.seed_reset',true)='sunpride-demo-v2' and exists (
      select 1 from sample_data_rows where table_name=TG_TABLE_NAME and row_id=old.id::text and batch='sunpride-demo-v2'
    ) then return old; end if;
    raise exception 'Retail master history is immutable';
  end if;
  select coalesce(array_agg(attname::text),'{}'::text[]) into generated_fields from pg_attribute where attrelid=TG_RELID and attgenerated<>'' and not attisdropped;
  if (to_jsonb(new)-generated_fields-array['effective_to','updated_at']) is distinct from (to_jsonb(old)-generated_fields-array['effective_to','updated_at'])
    or new.effective_to is null or new.effective_to<=old.effective_from
    or (old.effective_to is not null and new.effective_to>old.effective_to) then
    raise exception 'Publish a new retail master version';
  end if;
  return new;
end $$;
