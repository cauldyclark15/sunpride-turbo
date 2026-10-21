-- F-615: historical base-unit weights may be fractional (for example kilograms); targets still reconcile as integers.
alter table target_cascade_lines alter column basis type numeric(30,9) using basis::numeric;
