-- F-119 dependent postings wait for their original invoice/credit documents.
alter table integration_events add column depends_on jsonb not null default '[]' check(jsonb_typeof(depends_on)='array');
alter table van_sale_voids add column sap_document_number text;
create function guard_sap_event_dependencies() returns trigger language plpgsql as $$
begin
  if new.depends_on is distinct from old.depends_on then raise exception 'SAP posting dependencies are immutable'; end if;
  return new;
end $$;
create trigger integration_dependencies_immutable before update on integration_events for each row execute function guard_sap_event_dependencies();
