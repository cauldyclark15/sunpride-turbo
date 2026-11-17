-- SP-0191: per-person "Selling" switch. When on, the person's Field app phone (field-android) also counts as a van
-- phone on the van paths (trip, sale, receipts, refunds, close). Off by default; only role `sales` may have it on
-- (the API enforces that and treats a non-sales profile as off). Changes are audited and bump scope_epoch.
-- Additive only: the previous API version keeps working while this runs.
alter table profiles add column if not exists selling boolean not null default false;
