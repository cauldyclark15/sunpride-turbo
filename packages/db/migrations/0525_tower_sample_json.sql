-- F-603/F-604/F-606: repair only this lane's explicitly owned fictional samples.
-- Early sample generation encoded jsonb objects as JSON strings. Unwrap the representation,
-- not business values; never reset data, never touch a real/foreign source or marker.
update analytics_outlet_context r set payload=(r.payload #>> '{}')::jsonb,updated_at=now()
where r.source_type='sample' and r.source_system='sample-programme' and jsonb_typeof(r.payload)='string'
 and pg_input_is_valid(r.payload #>> '{}','jsonb')
 and exists(select 1 from sample_data_rows m where m.batch='sunpride-demo-v2' and m.table_name='analytics_outlet_context' and m.row_id=r.id::text and m.key like 'analytics_outlet_context:tower-%');
update analytics_trade_inputs r set lineage=(r.lineage #>> '{}')::jsonb,updated_at=now()
where r.source_type='sample' and r.source_system='sample-commercial' and jsonb_typeof(r.lineage)='string'
 and pg_input_is_valid(r.lineage #>> '{}','jsonb')
 and exists(select 1 from sample_data_rows m where m.batch='sunpride-demo-v2' and m.table_name='analytics_trade_inputs' and m.row_id=r.id::text and m.key like 'analytics_trade_inputs:tower-%');
update analytics_integrity_findings r set evidence=(r.evidence #>> '{}')::jsonb,updated_at=now()
where r.source_type='sample' and r.source_system='sample-integrity' and jsonb_typeof(r.evidence)='string'
 and pg_input_is_valid(r.evidence #>> '{}','jsonb')
 and exists(select 1 from sample_data_rows m where m.batch='sunpride-demo-v2' and m.table_name='analytics_integrity_findings' and m.row_id=r.id::text and m.key like 'analytics_integrity_findings:tower-integrity-%');
alter table analytics_outlet_context add constraint analytics_context_object check(jsonb_typeof(payload)='object');
alter table analytics_trade_inputs add constraint analytics_lineage_object check(jsonb_typeof(lineage)='object');
alter table analytics_integrity_findings add constraint analytics_integrity_evidence_object check(jsonb_typeof(evidence)='object');
