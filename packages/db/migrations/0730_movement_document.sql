-- IP-XFER: one movement document (SPEC 5.1) and multi-line goods receipt (SPEC 4.2).
-- stock_transfers gains a type, a dispatch header, a variance state and a reservation;
-- every line is tracked per batch in stock_transfer_allocations so receive can be partial
-- and short/over/damaged stay visible until a linked adjustment resolves them.
-- The stored status "shipped" is what the screens call "In transit / dispatched".

alter table stock_transfers drop constraint if exists stock_transfers_status_check;
alter table stock_transfers add constraint stock_transfers_status_check check (status in
  ('draft','requested','approved','reserved','picking','shipped','partially_received','received','closed','cancelled','review_needed','review_required'));

alter table stock_transfers
  add column type text not null default 'depot_transfer'
    check (type in ('depot_transfer','store_replenishment','van_load_out','van_reload','van_load_in','return_to_depot','recall_pull')),
  add column driver_name text,
  add column vehicle_plate text,
  add column receiver_name text,
  add column source_ref text,
  add column reserve_movement_id uuid references inventory_movements(id),
  add column picked_by text,
  add column picked_at timestamptz,
  add column approved_at timestamptz,
  add column dispatched_at timestamptz,
  add column first_received_at timestamptz,
  add column received_at timestamptz,
  add column closed_by text,
  add column closed_at timestamptz,
  add column variance_status text not null default 'none'
    check (variance_status in ('none','open','resolved','auto_accepted')),
  add column variance_value_centavos bigint not null default 0,
  add column final_receipt boolean not null default false;
create index stock_transfers_org_type_status_idx on stock_transfers (organization_id, type, status);
create index stock_transfers_org_source_ref_idx on stock_transfers (organization_id, source_ref) where source_ref is not null;

alter table stock_transfer_lines
  add column seq bigint generated always as identity,
  add column stock_status text not null default 'available'
    check (stock_status in ('available','quality_hold','quarantine','damaged','expired','rejected')),
  add column picked_base bigint not null default 0,
  add column received_good_base bigint not null default 0,
  add column received_damaged_base bigint not null default 0,
  add column received_hold_base bigint not null default 0,
  add column over_base bigint not null default 0,
  add column reason_code text,
  add column note text;

-- One row per (line, batch). Quantities are base units. short is only set once the receiver says
-- "that is all"; over is counted stock that was never sent (it is not in the ledger until resolved).
create table stock_transfer_allocations (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id text not null,
  transfer_id uuid not null references stock_transfers(id),
  transfer_line_id uuid not null references stock_transfer_lines(id),
  product_id uuid not null references products(id),
  lot_id uuid references inventory_lots(id),
  reserved_base bigint not null default 0,
  dispatched_base bigint not null default 0,
  received_good_base bigint not null default 0,
  received_damaged_base bigint not null default 0,
  received_hold_base bigint not null default 0,
  over_base bigint not null default 0,
  short_base bigint not null default 0,
  resolved_short_base bigint not null default 0,
  resolved_over_base bigint not null default 0,
  unit_cost_minor bigint not null default 0,
  quantity_scale bigint not null default 1,
  short_location_id uuid references inventory_locations(id),
  short_status text not null default 'in_transit',
  damage_reason_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reserved_base >= 0 and dispatched_base >= 0 and received_good_base >= 0 and received_damaged_base >= 0
    and received_hold_base >= 0 and over_base >= 0 and short_base >= 0)
);
create unique index stock_transfer_allocations_line_lot_key
  on stock_transfer_allocations (transfer_line_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index stock_transfer_allocations_transfer_idx on stock_transfer_allocations (transfer_id);
create trigger stock_transfer_allocations_set_updated_at before update on stock_transfer_allocations for each row execute function set_updated_at();

-- A variance is resolved by one person with authority, through one linked adjustment.
create table stock_transfer_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  transfer_id uuid not null references stock_transfers(id),
  adjustment_id uuid references inventory_adjustments(id),
  decided_by text not null,
  auto boolean not null default false,
  charge_to text not null check (charge_to in ('dispatch_side','receive_side','carrier','driver','tolerance','none')),
  short_reason_code text,
  over_reason_code text,
  short_base bigint not null default 0,
  over_base bigint not null default 0,
  value_centavos bigint not null default 0,
  note text,
  created_at timestamptz not null default now()
);
create index stock_transfer_resolutions_transfer_idx on stock_transfer_resolutions (transfer_id);

alter table inventory_adjustments add column source_transfer_id uuid references stock_transfers(id);

-- Goods receipt header (SPEC 4.2): supplier, delivery receipt no. (delivery_reference), PO ref.
alter table goods_receipts
  add column supplier_name text,
  add column purchase_order_ref text,
  add column carrier_name text,
  add column held_lines integer not null default 0,
  add column rejected_lines integer not null default 0;
alter table goods_receipt_lines
  add column rejected_reason_code text,
  add column note text,
  add column lot_number text,
  add column expires_at timestamptz;
