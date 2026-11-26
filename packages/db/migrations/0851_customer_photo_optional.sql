-- SP-0256: Store Photo is optional for new customer profiling.
-- Keep the other census requirements and existing photo references unchanged.
alter table census_captures drop constraint if exists census_captures_new_complete_ck;
alter table census_captures add constraint census_captures_new_complete_ck check (
  kind = 'change' or (channel_id is not null and subchannel_id is not null
    and estimated_class is not null)
);
