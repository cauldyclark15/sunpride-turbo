-- F-R01: Store is a configuration of the existing POS, not a new stock ledger.
alter table inventory_locations drop constraint inventory_locations_type_check;
alter table inventory_locations add constraint inventory_locations_type_check check
  (type in ('warehouse','zone','bin','production','wip','truck','in_transit','returns','virtual_boundary','store'));

create table store_registers (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references inventory_locations(id),
  terminal_code text not null unique,
  name text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>effective_from)
);
create table store_cashier_assignments (
  id uuid primary key default gen_random_uuid(),
  register_id uuid not null references store_registers(id),
  profile_id uuid not null references profiles(id),
  effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist (register_id with =, profile_id with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create table store_register_policies (
  id uuid primary key default gen_random_uuid(),
  register_id uuid not null references store_registers(id),
  tolerance_centavos bigint not null check(tolerance_centavos>=0),
  effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist (register_id with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create table pos_device_modes (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references registered_devices(id),
  register_id uuid references store_registers(id),
  mode text not null check(mode in ('van','store')),
  effective_from timestamptz not null, effective_to timestamptz,
  actor_profile_id uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(mode='van' or register_id is not null),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist (device_id with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create table store_shifts (
  id uuid primary key,
  register_id uuid not null references store_registers(id),
  mode_version_id uuid not null references pos_device_modes(id),
  policy_id uuid not null references store_register_policies(id),
  device_id uuid not null references registered_devices(id),
  cashier_id uuid not null references profiles(id),
  service_date date not null,
  opening_centavos bigint not null check(opening_centavos>=0),
  opened_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_shift_closures (
  id uuid primary key,
  shift_id uuid not null unique references store_shifts(id),
  declared_centavos bigint not null check(declared_centavos>=0),
  expected_centavos bigint not null,
  variance_centavos bigint not null,
  needs_review boolean not null,
  closed_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_shift_decisions (
  id uuid primary key default gen_random_uuid(),
  closure_id uuid not null unique references store_shift_closures(id),
  actor_profile_id uuid not null references profiles(id),
  decision text not null check(decision in ('accepted','investigate')),
  reason text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_pos_commands (
  id uuid primary key default gen_random_uuid(), actor_profile_id uuid not null references profiles(id),
  request_key uuid not null, payload_hash text not null, response jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(actor_profile_id,request_key)
);
-- One lock row per terminal serializes open, close and office reconfiguration.
create index store_shifts_register_day on store_shifts(register_id,service_date);
create index store_shifts_device on store_shifts(device_id);
create trigger store_shift_immutable before update or delete on store_shifts for each row execute function fiscal_immutable();
create trigger store_closure_immutable before update or delete on store_shift_closures for each row execute function fiscal_immutable();
create trigger store_decision_immutable before update or delete on store_shift_decisions for each row execute function fiscal_immutable();
create trigger store_register_audit after insert or update or delete on store_registers for each row execute function fiscal_capture_change();
create trigger store_mode_audit after insert or update or delete on pos_device_modes for each row execute function fiscal_capture_change();
create trigger store_policy_audit after insert or update or delete on store_register_policies for each row execute function fiscal_capture_change();
create trigger store_cashier_audit after insert or update or delete on store_cashier_assignments for each row execute function fiscal_capture_change();
create trigger store_shift_audit after insert on store_shifts for each row execute function fiscal_capture_change();
create trigger store_closure_audit after insert on store_shift_closures for each row execute function fiscal_capture_change();
create trigger store_decision_audit after insert on store_shift_decisions for each row execute function fiscal_capture_change();
