-- F-119: point the retained operational seam at the one canonical SAP event and real acknowledgement.
alter table van_sap_requests add column integration_event_id uuid references integration_events(id);
alter table van_sap_requests add column acknowledgement jsonb;
create index van_sap_request_event_idx on van_sap_requests(integration_event_id);
create trigger fiscal_capture after insert or update or delete on van_sap_requests for each row execute function fiscal_capture_change();
