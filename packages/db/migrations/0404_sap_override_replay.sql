-- F-003/F-404 exact client retry for the request-only FISCAL seam.
alter table sap_credit_override_requests add column request_key text;
alter table sap_credit_override_requests add column request_hash text;
create unique index sap_override_request_key on sap_credit_override_requests(requester_profile_id,request_key) where request_key is not null;
