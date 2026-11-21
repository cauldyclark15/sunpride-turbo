-- SP-0228: a salesman's cash remittance (Palawan, Cebuana, GCash, bank deposit, other) with a
-- required receipt photo, reviewed by Finance. Standalone for now; SP-0227 links it to the weekly
-- truck stock reconciliation later. This is not a depot cash hand-in (van_cash_remittances).
create table field_cash_remittances (
  id uuid primary key,
  salesman_profile_id uuid not null references profiles(id),
  org_unit_id uuid not null references org_units(id),
  device_id uuid references registered_devices(id),
  payload_hash text not null,
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 99999999999),
  channel text not null check (channel in ('palawan','cebuana','gcash','bank_deposit','other')),
  channel_other text check (channel_other is null or length(trim(channel_other)) between 1 and 80),
  reference_number text not null check (length(trim(reference_number)) between 1 and 80),
  remitted_at timestamptz not null,
  note text check (note is null or length(note) <= 500),
  photo_file_id uuid not null references files(id),
  status text not null default 'submitted' check (status in ('submitted','confirmed','rejected')),
  reject_reason text check (reject_reason is null or length(trim(reject_reason)) between 1 and 500),
  reviewed_by_profile_id uuid references profiles(id),
  reviewed_at timestamptz,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (channel <> 'other' or channel_other is not null),
  check (status <> 'rejected' or reject_reason is not null),
  check ((status = 'submitted') = (reviewed_at is null))
);
create index field_cash_remittances_unit_time on field_cash_remittances (org_unit_id, remitted_at desc);
create index field_cash_remittances_salesman on field_cash_remittances (salesman_profile_id, remitted_at desc);
create index field_cash_remittances_status on field_cash_remittances (status, remitted_at desc);
