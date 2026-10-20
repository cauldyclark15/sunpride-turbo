-- F-024/F-221/F-606: explicitly mark the invented default policy without claiming real client rules.
-- A separate batch avoids making a fresh core demo look partially seeded.
insert into sample_data_rows(batch,table_name,row_id,key)
select 'sunpride-integrity-policy','integrity_policy_versions',id::text,'integrity_policy_versions:sample-default'
from integrity_policy_versions
where code='field-integrity' and effective_from='2020-01-01'::timestamptz and source_ref='SAMPLE: provisional F-024/F-221/F-606 defaults'
on conflict do nothing;
