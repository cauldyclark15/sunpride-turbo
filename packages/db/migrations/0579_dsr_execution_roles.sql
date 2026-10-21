-- F-407: preserve the true granted partner actor in the existing append-only event stream.
-- This does NOT add distributor to any employee capability set.
-- The migrator keys complete filenames, so this additive sibling stays in FINISH-A's 0579 range.
alter table execution_events drop constraint execution_events_actor_role_check;
alter table execution_events add constraint execution_events_actor_role_check
  check(actor_role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer','distributor'));
