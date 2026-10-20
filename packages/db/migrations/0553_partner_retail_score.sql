-- F-319: agency billing's retail score requirement is a versioned,
-- office-editable contract value, never a hard-coded interpretation of MERCH.
alter table partner_contracts add column minimum_retail_score integer not null default 100
  check(minimum_retail_score between 0 and 100);
