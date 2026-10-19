-- Legacy effective targets remain intact for other months. A v2 month revision overrides
-- the legacy fallback without deleting a multi-month legacy standard.
alter table sales_targets drop constraint sales_targets_no_overlap;
alter table sales_targets add constraint sales_targets_no_overlap exclude using gist
 ((coalesce(profile_id,team_id,territory_id)) with =, subject_kind with =,
  period with =,metric with =,tstzrange(effective_from,effective_to,'[)') with &&)
 where(deleted_at is null and level is null);
-- v2 rows are separately protected by analytics_targets_current (month,level,target_key).
