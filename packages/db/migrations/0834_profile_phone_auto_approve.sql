-- SP-0209: a store-review account (the Google Play reviewer) cannot wait for the office to approve its phone.
-- `phone_auto_approve` is set ONLY by apps/api/scripts/create-play-reviewer.js (audited) and makes that person's
-- handheld phones register themselves on sign-in, the same way a super_admin's do (SP-0193, superadmin_auto rows).
-- Additive: the previous API version never reads the column and the default keeps every existing person unchanged.
alter table profiles add column if not exists phone_auto_approve boolean not null default false;
