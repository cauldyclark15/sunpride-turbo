-- F-015/F-016 read-only SAP master fields. The gateway marks its own transaction;
-- imports and office APIs cannot silently overwrite a replicated master.
create function guard_sap_product() returns trigger language plpgsql as $$
begin
  if old.sap_key is not null and current_setting('sunpride.sap_ingest',true) is distinct from 'on'
    and (new.name,new.category,new.uom,new.base_uom_id,new.quantity_scale,new.active,new.sap_key,new.sap_version,new.shelf_life_days,new.storage_condition)
      is distinct from (old.name,old.category,old.uom,old.base_uom_id,old.quantity_scale,old.active,old.sap_key,old.sap_version,old.shelf_life_days,old.storage_condition)
  then raise exception 'SAP-owned material is read only' using errcode='23514'; end if;
  return new;
end $$;
create trigger products_sap_readonly before update on products for each row execute function guard_sap_product();
create function guard_sap_pricing() returns trigger language plpgsql as $$
begin
  if current_setting('sunpride.sap_ingest',true)='on' then return new; end if;
  if (tg_table_name='price_lists' and old.source='sap') then raise exception 'SAP-owned prices are read only' using errcode='23514'; end if;
  return new;
end $$;
create trigger prices_sap_readonly before update on price_lists for each row execute function guard_sap_pricing();

-- F-004 track effective activation/expiry separately from arrival, so future validity also emits a delta.
create table sap_projection_grants (
  id uuid primary key,
  profile_id uuid not null,
  stamp text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table sap_master_publications (
  id uuid primary key,
  replica_id uuid not null references sap_replicas(id),
  expired boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
