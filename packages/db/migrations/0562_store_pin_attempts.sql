-- F-R01 PIN attempts are reserved outside the mode-change transaction, including refused attempts.
create table store_pin_attempts(device_id uuid primary key references registered_devices(id), next_attempt_at timestamptz not null);
