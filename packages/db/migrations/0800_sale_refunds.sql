-- IP-REFUND: refund part of a sale (store tills and vans) against the original invoice.
-- One table of refund documents for both surfaces (a refund is a BIR credit memo with its own number series), one table of the
-- lines each refund took back (so "sold minus already refunded" is a plain sum), and the single org-wide supervisor threshold.
-- Nothing here rewrites a sale: the original receipt, tax facts and movements stay as they were.

-- 1. Reason codes carry where the goods go: back to sellable stock or to damaged stock.
alter table inventory_reason_codes
  add column refund_destination text check (refund_destination in ('sellable', 'damaged'));
alter table inventory_reason_codes
  add constraint inventory_reason_codes_refund_category_check
  check (refund_destination is null or category = 'customer_return');

insert into inventory_reason_codes (organization_id, code, label, category, direction, requires_note, requires_photo, refund_destination) values
  ('sunpride', 'RF-CHANGED-MIND', 'Customer changed their mind',   'customer_return', 'in', false, false, 'sellable'),
  ('sunpride', 'RF-WRONG-ITEM',   'Wrong item was given',          'customer_return', 'in', false, false, 'sellable'),
  ('sunpride', 'RF-DAMAGED',      'Item is damaged or spoiled',    'customer_return', 'in', false, false, 'damaged'),
  ('sunpride', 'RF-EXPIRED',      'Item is expired',               'customer_return', 'in', false, false, 'damaged'),
  ('sunpride', 'RF-QUALITY',      'Quality complaint (write why)', 'customer_return', 'in', true,  false, 'damaged')
on conflict (organization_id, code) do nothing;

-- 2. One refund policy per organization: a refund above this amount needs a supervisor. Editable by the office; the shipped
-- value is a default, not confirmed by Sunpride (PHP 500.00).
create table refund_policies (
  organization_id text primary key default 'sunpride',
  supervisor_over_centavos bigint not null default 50000 check (supervisor_over_centavos >= 0),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into refund_policies (organization_id, supervisor_over_centavos, updated_by)
values ('sunpride', 50000, 'system:default');

-- 3. The refund document.
create table sale_refunds (
  id uuid primary key,
  surface text not null check (surface in ('store', 'van')),
  sale_id uuid not null,
  original_number text not null,
  shift_id uuid references store_shifts(id),
  trip_id uuid references van_trips(id),
  device_id uuid references registered_devices(id),
  requested_by uuid references profiles(id),
  supervisor_profile_id uuid references profiles(id),
  credit_number text not null unique,
  fiscal_document_id uuid references fiscal_documents(id),
  reason_code text not null,
  note text,
  destination text not null check (destination in ('sellable', 'damaged')),
  total_centavos bigint not null check (total_centavos >= 0),
  tax jsonb not null,
  lines jsonb not null,
  tenders jsonb not null default '[]'::jsonb,
  movement_id uuid references inventory_movements(id),
  captured_request jsonb not null,
  refunded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((surface = 'store' and shift_id is not null and trip_id is null) or (surface = 'van' and trip_id is not null and shift_id is null))
);
create index sale_refunds_sale on sale_refunds (sale_id);
create index sale_refunds_shift on sale_refunds (shift_id) where shift_id is not null;
create index sale_refunds_trip on sale_refunds (trip_id) where trip_id is not null;

create table sale_refund_lines (
  refund_id uuid not null references sale_refunds(id),
  sale_id uuid not null,
  line_index integer not null check (line_index >= 0),
  product_id uuid not null references products(id),
  quantity_base bigint not null check (quantity_base > 0),
  amount_centavos bigint not null check (amount_centavos >= 0),
  primary key (refund_id, line_index)
);
create index sale_refund_lines_sale on sale_refund_lines (sale_id, line_index);

create trigger sale_refund_audit after insert on sale_refunds for each row execute function fiscal_capture_change();
