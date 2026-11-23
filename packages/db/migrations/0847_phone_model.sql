-- SP-0233: optional, phone-reported hardware; old apps keep working unchanged.
alter table registered_devices add column manufacturer text, add column model text;
-- Preserve the first report while the office registers a waiting phone.
alter table phone_registration_requests add column manufacturer text, add column model text;
