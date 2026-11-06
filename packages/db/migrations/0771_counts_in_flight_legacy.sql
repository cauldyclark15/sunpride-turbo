-- IP-INT2FIX 0771: counts that were already running when counts v2 arrived finish under the old rules
-- (approve takes every line). A v2 count is recognisable: it was planned (planned_by) or it records when counting began.
update stock_count_sessions
   set legacy_whole = true
 where status in ('draft', 'frozen', 'counting', 'submitted', 'reviewed')
   and legacy_whole = false
   and planned_by is null
   and counting_started_at is null
   and assigned_to is null;
