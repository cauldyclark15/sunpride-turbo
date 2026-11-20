-- SP-0223: exact N-per-month requirements must not be inferred from rounded day intervals.
-- NULL preserves the existing day cadence; no invented default for existing customers.
ALTER TABLE outlets ADD COLUMN visit_frequency_per_month integer;
ALTER TABLE outlets ADD CONSTRAINT outlets_visit_frequency_per_month_check
  CHECK (visit_frequency_per_month IS NULL OR
    (visit_frequency_per_month BETWEEN 1 AND 31
      AND visit_frequency_days IS NOT NULL
      AND visit_frequency_days = greatest(1, 30 / visit_frequency_per_month)));
