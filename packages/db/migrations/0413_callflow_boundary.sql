-- F-006 F-207: preserve a missing checkout as unknown, without blocking every later working day.
-- This widens new CALLFLOW constraints; no business rows, queued bytes or financial facts are deleted.
alter table call_executions drop constraint call_executions_state_check;
alter table call_executions add constraint call_executions_state_check check(state in ('open','closed','interrupted'));
alter table call_executions add column interrupted_at timestamptz;
alter table call_flow_reviews drop constraint call_flow_reviews_kind_check;
alter table call_flow_reviews add constraint call_flow_reviews_kind_check check(kind in ('geofence_start','geofence_end','short_call','sequence','unplanned','day_boundary'));
