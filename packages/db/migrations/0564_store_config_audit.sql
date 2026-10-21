-- F-R05/F-R08: dated store-rule/target edits retain their exact before/after facts
-- in the shared immutable fiscal audit, never a parallel audit journal.
create function store_config_audit() returns trigger language plpgsql as $$
declare b jsonb; a jsonb; keys text[] := array[
 'id','register_id','product_id','source_location_id','minimum_base','target_base',
 'effective_from','effective_to','from_date','to_date','amount_centavos'
];
begin
 if tg_op<>'INSERT' then select jsonb_object_agg(key,value) into b from jsonb_each(to_jsonb(old)) where key=any(keys); end if;
 if tg_op<>'DELETE' then select jsonb_object_agg(key,value) into a from jsonb_each(to_jsonb(new)) where key=any(keys); end if;
 insert into fiscal_audit_events(table_name,row_id,action,actor_subject,before_facts,after_facts)
 values(tg_table_name,coalesce(a->>'id',b->>'id'),tg_op,coalesce(nullif(current_setting('sunpride.actor',true),''),'system:unattributed'),b,a);
 return coalesce(new,old);
end; $$;
create trigger store_target_audit after insert or update or delete on store_daily_targets for each row execute function store_config_audit();
create trigger store_reorder_audit after insert or update or delete on store_reorder_points for each row execute function store_config_audit();
