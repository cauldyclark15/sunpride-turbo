-- F-603/F-607 captured quantity encoding; base-unit granularity is not a live master lookup.
alter table analytics_trade_inputs add column quantity_scale integer check(quantity_scale>0);
-- Repair only this lane's explicitly owned fictional feed encoding. These records
-- have always represented whole base units: preserve every raw quantity and amount.
update analytics_trade_inputs r set quantity_scale=1,
 lineage=r.lineage||jsonb_build_object('baseEncoding','scaled','quantityScale',1),updated_at=now()
where r.quantity_scale is null and r.source_type='sample' and r.source_system='sample-commercial'
 and exists(select 1 from sample_data_rows m where m.batch='sunpride-demo-v2' and m.table_name='analytics_trade_inputs' and m.row_id=r.id::text and m.key like 'analytics_trade_inputs:tower-%');

