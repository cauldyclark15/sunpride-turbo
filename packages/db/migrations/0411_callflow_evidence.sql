-- F-107: one validated media reference cannot satisfy two independent call captures.
create unique index callflow_evidence_once on call_step_events(entity_id)
  where adapter='evidence' and entity_id is not null;
