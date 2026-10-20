-- F-019: retired allocations are permanently unavailable; no returned/recycled tail.
create table fiscal_allocation_closures (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null unique references fiscal_allocations(id),
  first_unissued bigint not null,
  last_serial bigint not null,
  outcome text not null check(outcome in ('unused_reconciled','lost_unreconciled')),
  reason text not null,
  evidence_reference text not null,
  actor_profile_id uuid not null references profiles(id),
  created_at timestamptz not null default now()
);
create trigger fiscal_allocation_closures_immutable before update or delete on fiscal_allocation_closures for each row execute function fiscal_immutable();

-- F-020: integrated master, approval, return and settlement writers use the same
-- allowlisted append-only audit projection. No credential/evidence payloads are copied.
do $$ declare t text; begin
  foreach t in array array[
    'identity_providers','federated_identities','fleet_asset_versions','device_integrity_exceptions',
    'call_flow_definitions','call_flow_channel_bindings','call_flow_policies','call_flow_reviews','call_flow_decisions','fiscal_allocation_closures',
    'van_settlements','van_settlement_decisions','van_reload_requests','van_variance_cases','van_variance_decisions',
    'outlet_class_visit_policies','target_cascades','target_cascade_lines','target_cascade_events',
    'mt_trade_terms','claims','claim_events','promotions'
  ] loop
    if to_regclass(t) is not null and not exists(select 1 from pg_trigger where tgrelid=to_regclass(t) and tgname='fiscal_capture') then
      execute format('create trigger fiscal_capture after insert or update or delete on %I for each row execute function fiscal_capture_change()',t);
    end if;
  end loop;
end; $$;
