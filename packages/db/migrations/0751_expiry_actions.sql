-- 0751 (IP-VALUE, SPEC 4.6): what the office did from the expiry board. A 'prioritise' row with
-- cleared_at null means "ship this batch first on the next load" (read by load suggestions).
create table inventory_expiry_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  lot_id uuid not null references inventory_lots(id),
  location_id uuid not null references inventory_locations(id),
  product_id uuid not null references products(id),
  action text not null check (action in ('hold', 'bad_order', 'prioritise')),
  quantity_base bigint check (quantity_base is null or quantity_base > 0),
  note text,
  movement_id uuid references inventory_movements(id),
  acted_by text not null,
  acted_at timestamptz not null default now(),
  cleared_at timestamptz
);
create index inventory_expiry_actions_lot_idx on inventory_expiry_actions (organization_id, lot_id, location_id, action) where cleared_at is null;
