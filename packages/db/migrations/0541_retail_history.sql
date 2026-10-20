-- F-311 F-314 F-316: publication closes an interval, never rewrites a historical target or agreement.
create function retail_master_immutable() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then
    if current_setting('sunpride.seed_reset',true)='sunpride-demo-v2' and exists (
      select 1 from sample_data_rows where table_name=TG_TABLE_NAME and row_id=old.id::text and batch='sunpride-demo-v2'
    ) then return old; end if;
    raise exception 'Retail master history is immutable';
  end if;
  if (to_jsonb(new)-'effective_to'-'updated_at') is distinct from (to_jsonb(old)-'effective_to'-'updated_at')
    or new.effective_to is null
    or new.effective_to<=old.effective_from
    or (old.effective_to is not null and new.effective_to>old.effective_to) then
    raise exception 'Publish a new retail master version';
  end if;
  return new;
end $$;
create trigger retail_master_history before update or delete on retail_master_versions for each row execute function retail_master_immutable();
create index retail_case_due on retail_action_cases(status,due_at,id);
create index retail_batch_lot on retail_batch_receipts(lot_id,outlet_id);
create index retail_recall_lot on retail_recall_cases(lot_id);
create index retail_recall_history on retail_recall_events(recall_id,outlet_id,created_at,id);
