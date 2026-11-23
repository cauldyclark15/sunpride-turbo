-- SP-0234: Field and Van registrations are independent. Keep one active ordinary
-- phone per person/app, with the existing owner/reviewer multi-phone exemption.
-- Replacements revoke the old rows transactionally before activating the new row.
drop index if exists registered_devices_one_person_active_uq;
