-- SP-0193: a super_admin's phone registers itself when they sign in (no waiting, no admin step), and a
-- super_admin may keep several phones active at once (the owner tests on more than one handset).
-- Only rows the server auto-approved for a super_admin carry `superadmin_auto`; the one-active-phone rules (F-007)
-- stay exactly as before for every other row and every other person.
-- Additive: the previous API version never writes the column and the narrowed indexes still hold for its rows.
alter table registered_devices add column if not exists superadmin_auto boolean not null default false;
drop index if exists registered_devices_one_person_active_uq;
create unique index registered_devices_one_person_active_uq on registered_devices(profile_id)
  where status = 'active' and not superadmin_auto;
drop index if exists registered_devices_active_uq;
create unique index registered_devices_active_uq on registered_devices (profile_id, app)
  where status = 'active' and not superadmin_auto;
