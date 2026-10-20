-- F-416: complete primary-feed periods are explicit SAP assertions, not inferred from an empty result.
create table distributor_primary_feed_receipts (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  source_key text not null, version bigint not null, payload_hash text not null,
  period_from date not null, period_to date not null,
  source text not null check(source in ('sample','sap')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(distributor_id,source_key,version), check(period_to>=period_from and period_to-period_from<=365)
);
-- F-405/F-406/F-414: corrections are new versions, never edited received facts.
create function distributor_immutable_fact() returns trigger language plpgsql as $$
begin
  raise exception 'Distributor received facts are immutable; append a new revision' using errcode='23514';
end;
$$;
create trigger distributor_secondary_immutable before update or delete on distributor_secondary_lines for each row execute function distributor_immutable_fact();
create trigger distributor_stock_immutable before update or delete on distributor_stock_lines for each row execute function distributor_immutable_fact();
create trigger distributor_declaration_immutable before update or delete on distributor_stock_declarations for each row execute function distributor_immutable_fact();
create trigger distributor_document_immutable before update or delete on distributor_documents for each row execute function distributor_immutable_fact();
