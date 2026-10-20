-- F-311 F-314 F-320: governed JSON payloads retain relational dependency guards.
-- This lets the existing sample-reset graph see real product/outlet/policy dependencies.
alter table retail_master_versions add column equipment_outlet_id uuid generated always as
  (case when kind='equipment' then (data->>'outletId')::uuid else null end) stored references outlets(id);
alter table retail_master_versions add column equipment_policy_id uuid generated always as
  (case when kind='equipment' then (data->>'policyVersionId')::uuid else null end) stored references retail_master_versions(id);
alter table retail_master_versions add column expiry_product_id uuid generated always as
  (case when kind='expiry_policy' then (data->>'productId')::uuid else null end) stored references products(id);
create function retail_guard_planogram_products() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from retail_master_versions m
    cross join lateral jsonb_array_elements(coalesce(m.data->'lines','[]'::jsonb)) line
    join deleted_products d on line->>'productId'=d.id::text
    where m.kind='planogram'
  ) then raise exception 'Retained planogram references this product'; end if;
  return null;
end $$;
create trigger retail_product_dependency after delete on products
  referencing old table as deleted_products for each statement execute function retail_guard_planogram_products();
