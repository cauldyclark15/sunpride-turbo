-- F-019/F-108/F-109: the downloaded registration/tax facts belong to the allocation,
-- not a mutable registration read at delayed sync. Legacy null allocations fail closed.
alter table fiscal_allocations add column registration_snapshot jsonb;
