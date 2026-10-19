-- VISITS owns 0220-0229. Raw observations and independent decisions never overwrite each other.
alter table visit_executions add column recording_device_id uuid references registered_devices(id);
alter table visit_executions add column activity_rules_snapshot jsonb;
alter table visit_location_evidence add column fix_time timestamptz;
alter table visit_location_evidence add column raw_location jsonb;
create unique index visits_one_open_call on visit_executions (assignee_profile_id, service_date)
  where deleted_at is null and state in ('arrived', 'checked-in', 'in-progress');
create unique index visits_one_execution_per_plan_stop on visit_executions (planned_visit_id)
  where planned_visit_id is not null and deleted_at is null;
create unique index visits_one_location_decision on execution_events (entity_id)
  where kind = 'location.exception.decided';
create unique index visits_one_merchandising_audit on merchandising_audits (visit_id) where deleted_at is null;
create unique index visits_one_photo_digest on field_evidence_files (visit_id, owner_profile_id, checksum);
create unique index visits_one_consumed_blob on evidence_upload_claims (storage_id) where storage_id is not null;
alter table field_collections add constraint field_collections_positive_amount check (amount_minor > 0);
create unique index visits_one_order_intent on visit_activities ((activity->>'clientOrderId'))
  where activity_kind = 'order_intent' and deleted_at is null;
create function visits_immutable_observation() returns trigger language plpgsql as $$
begin
  raise exception 'Visit raw evidence is append-only';
end;
$$;
create trigger visits_location_immutable before update or delete on visit_location_evidence
  for each row execute function visits_immutable_observation();
create trigger visits_events_immutable before update or delete on execution_events
  for each row execute function visits_immutable_observation();
