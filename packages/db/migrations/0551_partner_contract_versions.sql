-- F-319: contracts are versions, not mutable historical rate/policy records.
-- Reuse the shared version guard: only closing an effective interval is allowed.
create trigger partner_contract_version_guard before update on partner_contracts
  for each row execute function callflow_version_guard();
