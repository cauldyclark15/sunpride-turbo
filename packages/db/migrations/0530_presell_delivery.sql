-- F-301 F-302 F-303 F-304 F-308 F-612: extend the shared order and call-flow authorities.
create table presell_policies (
  id uuid primary key default gen_random_uuid(),
  channel_profile text not null default 'pre_sell', version integer not null check(version>0),
  label text not null, cutoff_minute integer not null check(cutoff_minute between 0 and 1439),
  lead_days integer not null check(lead_days between 0 and 30),
  horizon_days integer not null check(horizon_days between 1 and 90),
  sla_days integer not null check(sla_days between 0 and 90),
  epod_target_percent integer not null check(epod_target_percent between 1 and 100),
  variance_reasons jsonb not null check(jsonb_typeof(variance_reasons)='array'),
  effective_from timestamptz not null, effective_to timestamptz,
  source text not null check(source in ('sample','office')), published_by text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(channel_profile,version), check(effective_to is null or effective_to>effective_from),
  check(horizon_days>=lead_days)
);
create unique index presell_policy_current on presell_policies(channel_profile) where effective_to is null;
create table presell_order_promises (
  id uuid primary key default gen_random_uuid(), order_id uuid not null unique references orders(id),
  requested_delivery_date date not null, confirmed_delivery_date date,
  policy_id uuid not null references presell_policies(id), policy_snapshot jsonb not null,
  captured_at timestamptz not null, confirmed_at timestamptz, confirmed_by text, confirmation_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table delivery_handoffs (
  id uuid primary key default gen_random_uuid(), order_id uuid not null unique references orders(id),
  org_unit_id uuid not null references org_units(id), outlet_id uuid not null references outlets(id),
  status text not null default 'pending' check(status in ('pending','acknowledged','failed','cancelled')),
  snapshot jsonb not null, payload_hash text not null, attempts integer not null default 0,
  sap_reference text, source text, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index delivery_handoffs_pending on delivery_handoffs(status,created_at);
create table delivery_runs (
  id uuid primary key default gen_random_uuid(), trip_id uuid not null unique references van_trips(id),
  label text not null, status text not null default 'planning' check(status in ('planning','released','closed')),
  created_by text not null, released_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table delivery_drops (
  id uuid primary key default gen_random_uuid(), handoff_id uuid not null unique references delivery_handoffs(id),
  run_id uuid references delivery_runs(id), sequence integer check(sequence>0),
  status text not null default 'ready' check(status in ('ready','scheduled','delivered','variance','cancelled')),
  window_start timestamptz, window_end timestamptz, booking_reference text,
  arrived_at timestamptz, unloading_at timestamptz, departed_at timestamptz,
  window_breach_reason text, eta timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(run_id,sequence) deferrable initially deferred,
  check((window_start is null and window_end is null) or window_start<window_end)
);
create table delivery_drop_lines (
  id uuid primary key default gen_random_uuid(), drop_id uuid not null references delivery_drops(id),
  order_line_id uuid not null references order_lines(id), ordinal integer not null,
  product_id uuid not null references products(id), product_code text not null, description text not null,
  uom text not null, ordered_quantity numeric(14,3) not null check(ordered_quantity>0),
  expected_base bigint not null check(expected_base>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(drop_id,ordinal), unique(drop_id,order_line_id)
);
create table delivery_receiving_slots (
  id uuid primary key default gen_random_uuid(), outlet_id uuid not null references outlets(id),
  label text not null, starts_at timestamptz not null, ends_at timestamptz not null,
  capacity integer not null check(capacity between 1 and 50), source text not null check(source in ('sample','office')),
  created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(starts_at<ends_at)
);
create table delivery_appointments (
  id uuid primary key default gen_random_uuid(), drop_id uuid not null references delivery_drops(id),
  slot_id uuid not null references delivery_receiving_slots(id), booking_reference text not null,
  cancelled_at timestamptz, created_by text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index delivery_active_appointment on delivery_appointments(drop_id) where cancelled_at is null;
create index delivery_slot_capacity on delivery_appointments(slot_id) where cancelled_at is null;
create table delivery_proofs (
  id uuid primary key default gen_random_uuid(), drop_id uuid not null unique references delivery_drops(id),
  call_id uuid not null references call_executions(id), profile_id uuid not null references profiles(id),
  device_id uuid not null references registered_devices(id), operation_key uuid not null,
  photo_id uuid not null unique references van_damage_photos(id),
  signature jsonb not null, receiver_name text not null, location jsonb not null,
  captured_at timestamptz not null, watermark jsonb not null, lines jsonb not null,
  payload_hash text not null, within_sla boolean not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table delivery_variances (
  id uuid primary key default gen_random_uuid(), proof_id uuid not null references delivery_proofs(id),
  drop_line_id uuid not null references delivery_drop_lines(id), accepted_base bigint not null check(accepted_base>=0),
  short_base bigint not null check(short_base>=0), rejected_base bigint not null check(rejected_base>=0),
  damaged_base bigint not null check(damaged_base>=0), reason text not null, note text,
  sap_status text not null default 'pending' check(sap_status in ('pending','mock_acknowledged','posted')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(proof_id,drop_line_id)
);
create table delivery_notification_outbox (
  id uuid primary key default gen_random_uuid(), drop_id uuid not null references delivery_drops(id),
  request_key text not null unique, channel text not null check(channel in ('sms','email')),
  recipient text not null, message text not null, eta timestamptz not null,
  status text not null default 'pending' check(status in ('pending','sent','failed')),
  attempts integer not null default 0, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table delivery_notification_sink (
  id uuid primary key default gen_random_uuid(), notification_id uuid not null unique references delivery_notification_outbox(id),
  adapter text not null default 'mock', channel text not null, recipient text not null, message text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table presell_commands (
  id uuid primary key default gen_random_uuid(), actor_subject text not null, request_key text not null,
  payload_hash text not null, response jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(actor_subject,request_key)
);
create function presell_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('sunpride.sample_reset',true)='on' then return old; end if;
  raise exception 'Delivery evidence is immutable';
end $$;
create trigger delivery_proof_immutable before update or delete on delivery_proofs for each row execute function presell_immutable();
-- Financial effects are requests for SAP, never alternate stock-balance or credit-ledger writes.
