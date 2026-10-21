-- F-404: keep the one fiscal decision and the separately authoritative SAP acknowledgement.
alter table sap_credit_override_requests drop constraint sap_credit_override_requests_status_check;
alter table sap_credit_override_requests add constraint sap_credit_override_requests_status_check check(status in ('pending_sap','submitted','rejected','approved'));
alter table sap_credit_override_requests add column request_facts jsonb not null default '{}';
alter table sap_credit_override_requests add column sap_reference text;
alter table sap_credit_override_requests add column sap_expires_at timestamptz;
alter table sap_credit_override_requests add column sap_result jsonb;
create unique index sap_credit_exception_receipt_unique on sap_credit_override_requests(sap_reference) where sap_reference is not null;
