-- ORDERS owns commercial facts; legacy decimal columns remain for analytics readers.
-- All new calculations and wire amounts use integer centavos, never product.unit_price.
create sequence orders_document_seq;
alter table orders add column org_unit_id uuid references org_units(id);
alter table orders add column salesperson_profile_id uuid references profiles(id);
alter table orders add column created_by_subject text;
alter table orders add column outlet_id uuid references outlets(id);
alter table orders add column territory_id uuid references territories(id);
alter table orders add column channel_key text;
alter table orders add column service_date date;
alter table orders add column subtotal_centavos bigint;
alter table orders add column total_centavos bigint;
alter table orders add column amount_known boolean not null default true;
alter table orders add column credit_status text check (credit_status in ('within','over','no_limit','unknown'));
alter table orders add column credit_limit_centavos bigint;
alter table orders add column credit_exposure_centavos bigint;
alter table orders add column pricing_snapshot jsonb;
alter table orders add column source_activity_id uuid references visit_activities(id);
alter table orders add column outside_call_id uuid references outside_call_orders(id);
create unique index orders_source_activity_key on orders(source_activity_id) where source_activity_id is not null;
create unique index orders_outside_call_key on orders(outside_call_id) where outside_call_id is not null;
create index orders_scope_date_idx on orders(org_unit_id, service_date, id);
alter table order_lines add column ordinal integer;
alter table order_lines add column product_id uuid references products(id);
alter table order_lines add column uom text;
alter table order_lines add column quantity_base bigint;
alter table order_lines add column unit_price_centavos bigint;
alter table order_lines add column line_total_centavos bigint;
alter table order_lines add column price_list_id uuid references price_lists(id);
alter table outside_call_orders add column request_payload_hash text;
create unique index outside_call_orders_live_po_key on outside_call_orders(outlet_id, po_number) where status <> 'cancelled' and deleted_at is null;

create table order_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  actor_subject text not null,
  action text not null,
  from_status text,
  to_status text not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_history_order_idx on order_history(order_id, created_at, id);
create table orders_commands (
  id uuid primary key default gen_random_uuid(),
  actor_subject text not null,
  request_key text not null,
  payload_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(actor_subject, request_key)
);
-- Bridge deduplication: distinct op UUIDs cannot duplicate the same captured phone order.
create table field_order_captures (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visit_executions(id),
  client_order_id text not null,
  activity_id uuid not null references visit_activities(id),
  order_id uuid not null references orders(id),
  payload_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(visit_id, client_order_id)
);
create index field_order_captures_order_idx on field_order_captures(order_id);
-- Additive: frozen-schema metrics stays unused. ANALYTICS replaces it.
