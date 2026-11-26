-- SP-0240: a saved full name no longer requires manual split-name mapping.
-- Repair only flags caused entirely by the retired first/last required checks.
-- Do not split, compose, replace or clear any saved name.
with decoded as (
  select p.outlet_id,
    case when jsonb_typeof(p.field_missing) = 'string'
      and pg_input_is_valid(p.field_missing #>> '{}', 'jsonb')
      then (p.field_missing #>> '{}')::jsonb
      else p.field_missing end as missing
  from customer_profiles p join outlets o on o.id = p.outlet_id
  where o.deleted_at is null and p.deleted_at is null and length(trim(o.name)) > 0
), candidates as (
  select outlet_id,
    case when jsonb_typeof(missing) = 'array' then missing else '[]'::jsonb end as missing
  from decoded
)
update customer_profiles p
set field_missing = null, completeness = 'complete'
from candidates c
where p.outlet_id = c.outlet_id and jsonb_array_length(c.missing) > 0
  and not exists (
    select 1 from jsonb_array_elements(c.missing) e
    where coalesce(e->>'field', '') not in ('firstName', 'lastName')
       or coalesce(e->>'code', 'required') <> 'required'
       or coalesce(e->>'message', '') not in ('First Name is required.', 'Last Name is required.')
  );
