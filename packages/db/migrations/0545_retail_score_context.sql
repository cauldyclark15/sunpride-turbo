-- F-316: preserve the score policy actually applied to an observed visit, including sample-reset dependencies.
alter table retail_execution_audits add column scorecard_version_id uuid
  generated always as ((facts->'scorecardContext'->>'versionId')::uuid) stored
  references retail_master_versions(id);
create index retail_audit_scorecard on retail_execution_audits(scorecard_version_id);
