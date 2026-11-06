-- Document numbers (IP-FOUND, SPEC 3.3): TYPE-LOC-YYMMDD-NNNN, one counter per type, location and Manila day.
create table document_sequences (
  organization_id text not null default 'sunpride',
  doc_type text not null check (doc_type in ('TRF','LOAD','RLD','LIN','RCV','CNT','ADJ','DSP','REM','SHF','TILL','Z')),
  location_code text not null check (location_code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  business_date date not null,
  last_value integer not null check (last_value > 0),
  primary key (organization_id, doc_type, location_code, business_date)
);
