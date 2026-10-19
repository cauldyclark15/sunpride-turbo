-- Counting cash on a handheld is not evidence that the office received it.
create table van_cash_remittances (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null unique references van_trips(id),
  count_id uuid not null unique references van_cash_counts(id),
  amount_centavos bigint not null check(amount_centavos>=0),
  received_by uuid not null references profiles(id),
  received_by_name text not null,
  reference text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
