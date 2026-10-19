-- VAN-owned additive settlement facts. Canonical stock remains inventory/posting.js.
create table van_sales (
  id uuid primary key,
  trip_id uuid not null references van_trips(id),
  receipt_number text not null unique,
  outlet_id uuid references outlets(id),
  customer_code text,
  total_centavos bigint not null check (total_centavos >= 0),
  discount_centavos bigint not null default 0,
  receipt jsonb not null,
  captured_request jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index van_sales_trip_idx on van_sales(trip_id);
create table van_sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references van_sales(id),
  ordinal integer not null,
  product_id uuid not null references products(id),
  quantity_base bigint not null check (quantity_base > 0),
  total_centavos bigint not null check (total_centavos >= 0),
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sale_id, ordinal)
);
create table van_returns (
  id uuid primary key,
  trip_id uuid not null references van_trips(id),
  sale_id uuid references van_sales(id),
  return_number text not null unique,
  captured_request jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index van_returns_trip_idx on van_returns(trip_id);
create table van_return_lines (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references van_returns(id),
  ordinal integer not null,
  product_id uuid not null references products(id),
  quantity_base bigint not null check (quantity_base > 0),
  stock_status text not null check (stock_status in ('available','damaged','none')),
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(return_id, ordinal)
);
create table van_approval_codes (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references van_trips(id),
  kind text not null check(kind in ('void','cash','stock','discount')),
  facts_hash text not null,
  facts jsonb not null,
  issuer_profile_id uuid not null references profiles(id),
  issuer_name text not null,
  consumed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(trip_id,kind,facts_hash)
);
create table van_sale_voids (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null unique references van_sales(id),
  trip_id uuid not null references van_trips(id),
  reason text not null,
  approval_id uuid not null references van_approval_codes(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table van_payments (
  id uuid primary key,
  trip_id uuid not null references van_trips(id),
  sale_id uuid references van_sales(id),
  return_id uuid references van_returns(id),
  kind text not null check(kind in ('sale','collection','refund','void_refund')),
  method text not null,
  amount_centavos bigint not null check(amount_centavos >= 0),
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index van_payments_trip_idx on van_payments(trip_id);
-- Append-only per-trip stock explanation, never a balance/ledger writer.
create table van_stock_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references van_trips(id),
  source_id uuid not null,
  kind text not null,
  product_id uuid not null references products(id),
  stock_status text not null check(stock_status in ('available','damaged')),
  delta_base bigint not null,
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index van_stock_events_trip_idx on van_stock_events(trip_id, product_id, stock_status);
create table van_cash_counts (
  id uuid primary key,
  trip_id uuid not null unique references van_trips(id),
  expected_centavos bigint not null,
  declared_centavos bigint not null,
  variance_centavos bigint not null,
  approval_id uuid references van_approval_codes(id),
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table van_stock_counts (
  id uuid primary key,
  trip_id uuid not null unique references van_trips(id),
  count_code text not null,
  variance_lines integer not null,
  short_base bigint not null,
  over_base bigint not null,
  approval_id uuid references van_approval_codes(id),
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table van_stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references van_stock_counts(id),
  product_id uuid not null references products(id),
  stock_status text not null,
  expected_base bigint not null,
  counted_base bigint not null,
  variance_base bigint not null,
  value_centavos bigint,
  facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(count_id,product_id,stock_status)
);
create table van_audit_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references van_trips(id),
  actor_profile_id uuid not null references profiles(id),
  actor_name text not null,
  kind text not null,
  entity_id text not null,
  details jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index van_audit_events_trip_idx on van_audit_events(trip_id,created_at);
create table van_web_commands (
  actor_profile_id uuid not null references profiles(id),
  idempotency_key text not null,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(actor_profile_id,idempotency_key)
);
-- One truck and seller own a day (cancelled trips release the slot).
create unique index van_trips_vehicle_day_active on van_trips(vehicle_id,service_date)
  where status not in ('cancelled','closed') and deleted_at is null;
create unique index van_trips_seller_day_active on van_trips(salesperson_profile_id,service_date)
  where status not in ('cancelled','closed') and deleted_at is null;
-- Damage evidence becomes trip-bound, consumed once; the files table already binds uploader/device.
alter table van_damage_photos add column trip_id uuid references van_trips(id);
