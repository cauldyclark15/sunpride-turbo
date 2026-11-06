-- IP-ZDAY 0722: cash movements, per-supervisor PINs, the override log, session events and forced closes.
create table store_cash_movements (
  id uuid primary key,
  register_id uuid not null references store_registers(id),
  till_day_id uuid not null references store_till_days(id),
  shift_id uuid not null references store_shifts(id),
  kind text not null check (kind in ('float','drop','pickup','paid_out','paid_in','no_sale')),
  amount_centavos bigint not null check (amount_centavos >= 0 and (kind = 'no_sale' or amount_centavos > 0)),
  reason_code text not null,
  note text,
  supervisor_profile_id uuid references profiles(id),
  override_id uuid,
  slip_number text,
  recorded_by uuid not null references profiles(id),
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index store_cash_movements_shift on store_cash_movements(shift_id, captured_at);
create index store_cash_movements_day on store_cash_movements(till_day_id);
create trigger store_cash_movement_immutable before update or delete on store_cash_movements for each row execute function fiscal_immutable();
create trigger store_cash_movement_audit after insert on store_cash_movements for each row execute function fiscal_capture_change();

create table store_supervisor_pins (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  pin_salt text not null, pin_hash text not null, pin_key text not null,
  effective_from timestamptz not null, effective_to timestamptz,
  set_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  exclude using gist (profile_id with =, tstzrange(effective_from, effective_to, '[)') with &&)
);
create trigger store_supervisor_pin_audit after insert or update on store_supervisor_pins for each row execute function fiscal_capture_change();
create table store_supervisor_pin_attempts (
  profile_id uuid primary key references profiles(id),
  failed_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

create table store_overrides (
  id uuid primary key,
  register_id uuid not null references store_registers(id),
  till_day_id uuid references store_till_days(id),
  shift_id uuid references store_shifts(id),
  kind text not null check (kind in ('void_line','void_sale','refund','price','discount','reprint','no_sale','cash_drop','cash_pickup','paid_out','z_reading','force_close')),
  method text not null check (method in ('pin_online','pin_offline','office')),
  supervisor_profile_id uuid not null references profiles(id),
  supervisor_pin_id uuid references store_supervisor_pins(id),
  cashier_profile_id uuid references profiles(id),
  reason text,
  amount_centavos bigint,
  ref_type text, ref_id text,
  captured_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create index store_overrides_register on store_overrides(register_id, captured_at desc);
create trigger store_override_immutable before update or delete on store_overrides for each row execute function fiscal_immutable();
create trigger store_override_audit after insert on store_overrides for each row execute function fiscal_capture_change();

create table store_session_events (
  id uuid primary key,
  shift_id uuid not null references store_shifts(id),
  kind text not null check (kind in ('suspended','resumed')),
  reason text,
  actor_profile_id uuid not null references profiles(id),
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index store_session_events_shift on store_session_events(shift_id, captured_at);
create trigger store_session_event_immutable before update or delete on store_session_events for each row execute function fiscal_immutable();

alter table store_shift_closures add column kind text not null default 'cashier' check (kind in ('cashier','forced'));
alter table store_shift_closures add column forced_by uuid references profiles(id);
alter table store_shift_closures add column force_reason text;
