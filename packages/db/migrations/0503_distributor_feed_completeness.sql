-- F-411/F-412: explicit complete-period assertions distinguish zero sales from missing feeds.
alter table distributor_ingest_runs add column period_from date;
alter table distributor_ingest_runs add column period_to date;
alter table distributor_ingest_runs add column complete boolean not null default false;
alter table distributor_ingest_runs add constraint distributor_ingest_period check (not complete or (period_from is not null and period_to is not null and period_to>=period_from and period_to-period_from<=365));
-- Raw source fingerprints allow exact replay despite a later pack-size or code-map change.
alter table distributor_secondary_lines add column source_payload_hash text;
