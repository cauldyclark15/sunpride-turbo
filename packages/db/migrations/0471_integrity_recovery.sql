-- F-007: unsent work is sealed on the server BEFORE deleting the local partition.
-- This is supervised recovery, never automatic replay into business writers.
create table device_recovery_bundles (
 id uuid primary key default gen_random_uuid(), control_id uuid not null unique references device_controls(id),
 device_id uuid not null references registered_devices(id), digest text not null,
 ciphertext text not null, nonce text not null, queued_count integer not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger device_recovery_bundles_immutable before update or delete on device_recovery_bundles for each row execute function integrity_immutable();
