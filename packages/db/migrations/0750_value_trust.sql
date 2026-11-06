-- 0750 (IP-VALUE, SPEC 4.4 / 4.7): dispositions of bad-order stock, and the nightly stock-integrity check.
-- Dispositions: damaged / expired / rejected / held stock waits here for a decision (write off, return to
-- supplier, destroy with photo, release). The stock change itself is ONE posting through inventory/posting.js.
create table inventory_dispositions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  disposition_number text not null,
  product_id uuid not null references products(id),
  lot_id uuid references inventory_lots(id),
  location_id uuid not null references inventory_locations(id),
  from_stock_status text not null check (from_stock_status in ('damaged', 'expired', 'rejected', 'quarantine', 'quality_hold')),
  quantity_base bigint not null check (quantity_base > 0),
  unit_cost_minor bigint not null default 0,
  value_minor bigint not null default 0,
  decision text not null check (decision in ('write_off', 'return_to_supplier', 'destroy', 'release')),
  reason_code text,
  note text,
  supplier_ref text,
  status text not null check (status in ('requested', 'approved', 'posted', 'rejected')),
  approval_level text not null check (approval_level in ('supervisor', 'manager')),
  threshold_minor bigint,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  movement_id uuid references inventory_movements(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inventory_dispositions_number_key on inventory_dispositions (organization_id, disposition_number);
create index inventory_dispositions_status_idx on inventory_dispositions (organization_id, status, requested_at);
create index inventory_dispositions_stock_idx on inventory_dispositions (organization_id, product_id, location_id, status);
create trigger inventory_dispositions_set_updated_at before update on inventory_dispositions for each row execute function set_updated_at();

create table inventory_disposition_photos (
  id uuid primary key default gen_random_uuid(),
  disposition_id uuid not null references inventory_dispositions(id),
  file_id uuid not null references files(id),
  sha256 text not null,
  added_by text not null,
  created_at timestamptz not null default now(),
  unique (disposition_id, file_id)
);

-- Nightly integrity: the existing reconciliation tables carry the run and its differences;
-- these columns say WHAT was compared, and the alert table is what the office sees.
alter table inventory_reconciliation_differences add column check_kind text;
alter table inventory_reconciliation_differences add column entity_ref text;
alter table inventory_reconciliation_differences add column detail jsonb;

create table inventory_integrity_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  run_id uuid references inventory_reconciliation_runs(id),
  kind text not null,
  severity text not null check (severity in ('warning', 'critical')),
  message text not null,
  detail jsonb,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index inventory_integrity_alerts_open_idx on inventory_integrity_alerts (organization_id, status, created_at);
create trigger inventory_integrity_alerts_set_updated_at before update on inventory_integrity_alerts for each row execute function set_updated_at();
