-- 0107_inventory: Canonical inventory: locations, lots, movements, ledger, documents.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: inventory_locations, product_inventory_policies, replenishment_policies, inventory_movements, inventory_balances, inventory_lots, inventory_lot_balances, inventory_commands, inventory_movement_lines, inventory_allocations, inventory_ledger_entries, inventory_reservations, inventory_reservation_lines, goods_receipts, goods_receipt_lines, truck_route_sessions, stock_transfers, stock_transfer_lines, stock_count_sessions, stock_count_lines, inventory_adjustments, inventory_adjustment_lines, bill_of_materials, bill_of_material_versions, bill_of_material_components, production_orders, production_material_issues, production_output_receipts, lot_genealogy_links, truck_inventory_checkpoints, truck_inventory_checkpoint_lines, negative_stock_allowances, negative_stock_flags, inventory_reconciliation_runs, inventory_reconciliation_differences.

-- inventoryLocations [synced]
create table inventory_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid,
  site_code text not null,
  warehouse_id uuid,
  parent_location_id uuid,
  code text not null,
  name text not null,
  type text not null check (type in ('warehouse', 'zone', 'bin', 'production', 'wip', 'truck', 'in_transit', 'returns', 'virtual_boundary')),
  active boolean not null,
  allows_picking boolean not null,
  allows_receiving boolean not null,
  allows_sale boolean not null,
  allows_production boolean not null,
  external_id text,
  truck_code text,
  assigned_device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index inventory_locations_org_unit_id_idx on inventory_locations (org_unit_id);
create unique index inventory_locations_organization_id_and_code_key on inventory_locations (organization_id, code);
create index inventory_locations_organization_id_and_site_code_and__1bd11d4a on inventory_locations (organization_id, site_code, type, active);
create index inventory_locations_organization_id_and_warehouse_id_a_6059b38f on inventory_locations (organization_id, warehouse_id, parent_location_id);
create index inventory_locations_organization_id_and_truck_code_idx on inventory_locations (organization_id, truck_code);
create index inventory_locations_change_seq_idx on inventory_locations (change_seq);
create trigger inventory_locations_bump_change_seq before update on inventory_locations for each row execute function bump_change_seq();

-- productInventoryPolicies [synced]
create table product_inventory_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid not null,
  base_uom_id uuid not null,
  quantity_scale bigint not null,
  quantity_precision integer not null,
  tracking_mode text not null check (tracking_mode in ('none', 'lot', 'serial')),
  allocation_policy text not null check (allocation_policy in ('fefo', 'fifo', 'explicit_only')),
  allow_mixed_lots_per_line boolean not null,
  allow_negative_stock boolean not null,
  quality_release_required boolean not null,
  shelf_life_days integer,
  expiry_date_required boolean not null,
  manufacture_date_required boolean not null,
  minimum_remaining_shelf_life_days integer not null,
  costing_method text not null check (costing_method in ('weighted_average', 'fifo_layer')),
  version integer not null,
  active boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index product_inventory_policies_organization_id_and_product_id_key on product_inventory_policies (organization_id, product_id);
create index product_inventory_policies_organization_id_and_trackin_9adc5bf5 on product_inventory_policies (organization_id, tracking_mode, active);
create index product_inventory_policies_change_seq_idx on product_inventory_policies (change_seq);
create trigger product_inventory_policies_bump_change_seq before update on product_inventory_policies for each row execute function bump_change_seq();

-- replenishmentPolicies
create table replenishment_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid not null,
  location_id uuid,
  enabled boolean not null,
  reorder_point_base bigint not null,
  target_level_base bigint not null,
  safety_stock_base bigint not null,
  lead_time_days integer,
  alert_cooldown_ms bigint not null,
  last_alert_state text check (last_alert_state in ('ok', 'low')),
  last_alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index replenishment_policies_organization_id_and_product_id__2b741169 on replenishment_policies (organization_id, product_id, location_id);
create index replenishment_policies_organization_id_and_enabled_idx on replenishment_policies (organization_id, enabled);
create unique index replenishment_policies_org_product_location_key on replenishment_policies (organization_id, product_id, location_id) nulls not distinct;
create trigger replenishment_policies_set_updated_at before update on replenishment_policies for each row execute function set_updated_at();

-- inventoryMovements
create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  movement_number text not null,
  movement_type text not null check (movement_type in ('opening_balance', 'goods_receipt', 'inventory_issue', 'reservation', 'reservation_release', 'transfer_ship', 'transfer_receive', 'inventory_adjustment', 'status_change', 'pos_sale', 'pos_void', 'pos_return', 'production_issue', 'production_output', 'production_scrap', 'reversal', 'van_load', 'van_unload')),
  source_type text not null,
  source_document_id text,
  status text not null check (status in ('posted', 'reversed')),
  effective_at timestamptz not null,
  posted_at timestamptz not null,
  posted_by text not null,
  device_id text,
  idempotency_key text not null,
  reason_code text,
  note text,
  reverses_movement_id uuid,
  reversed_by_movement_id uuid,
  schema_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inventory_movements_organization_id_and_movement_number_key on inventory_movements (organization_id, movement_number);
create index inventory_movements_organization_id_and_source_type_an_46163b65 on inventory_movements (organization_id, source_type, source_document_id);
create index inventory_movements_organization_id_and_movement_type__d959629d on inventory_movements (organization_id, movement_type, effective_at);
create index inventory_movements_organization_id_and_posted_at_idx on inventory_movements (organization_id, posted_at);
create index inventory_movements_organization_id_and_reverses_movem_555e9d12 on inventory_movements (organization_id, reverses_movement_id);
create trigger inventory_movements_set_updated_at before update on inventory_movements for each row execute function set_updated_at();

-- inventoryBalances [synced]
create table inventory_balances (
  id uuid primary key default gen_random_uuid(),
  product_code text not null,
  warehouse_code text not null,
  on_hand numeric(14,3) not null,
  reserved numeric(14,3) not null,
  available numeric(14,3) not null,
  as_of timestamptz not null,
  organization_id text,
  product_id uuid,
  location_id uuid,
  physical_base bigint,
  available_stock_base bigint,
  reserved_base bigint,
  available_base bigint,
  quality_hold_base bigint,
  quarantine_base bigint,
  damaged_base bigint,
  expired_base bigint,
  rejected_base bigint,
  wip_base bigint,
  in_transit_base bigint,
  weighted_average_cost_minor bigint,
  inventory_value_minor bigint,
  version integer,
  last_movement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index inventory_balances_product_warehouse_idx on inventory_balances (product_code, warehouse_code);
create index inventory_balances_warehouse_idx on inventory_balances (warehouse_code);
create index inventory_balances_organization_id_and_product_id_and__6969c02b on inventory_balances (organization_id, product_id, location_id);
create index inventory_balances_organization_id_and_location_id_and_a9f2931b on inventory_balances (organization_id, location_id, product_id);
create unique index inventory_balances_org_product_location_key on inventory_balances (organization_id, product_id, location_id) where product_id is not null and location_id is not null;
create index inventory_balances_change_seq_idx on inventory_balances (change_seq);
create trigger inventory_balances_bump_change_seq before update on inventory_balances for each row execute function bump_change_seq();

-- inventoryLots
create table inventory_lots (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid not null,
  lot_number text not null,
  normalized_lot_number text not null,
  supplier_lot_number text,
  source_type text not null,
  source_document_id text,
  source_line_id text,
  manufactured_at timestamptz,
  received_at timestamptz not null,
  expires_at timestamptz,
  quality_status text not null check (quality_status in ('pending', 'released', 'quarantined', 'rejected', 'expired')),
  unit_cost_minor bigint,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inventory_lots_organization_id_and_product_id_and_norm_750ffe29 on inventory_lots (organization_id, product_id, normalized_lot_number);
create index inventory_lots_organization_id_and_product_id_and_expi_2adf0818 on inventory_lots (organization_id, product_id, expires_at);
create index inventory_lots_organization_id_and_quality_status_and__7773f32b on inventory_lots (organization_id, quality_status, expires_at);
create index inventory_lots_organization_id_and_source_type_and_sou_1ca2fb39 on inventory_lots (organization_id, source_type, source_document_id);
create trigger inventory_lots_set_updated_at before update on inventory_lots for each row execute function set_updated_at();

-- inventoryLotBalances
create table inventory_lot_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid not null,
  lot_id uuid not null,
  location_id uuid not null,
  stock_status text not null check (stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  physical_base bigint not null,
  reserved_base bigint not null,
  available_base bigint not null,
  expiry_sort_key bigint not null,
  receipt_sequence bigint not null,
  version integer not null,
  last_movement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_lot_balances_org_product_location_status_expiry_idx on inventory_lot_balances (organization_id, product_id, location_id, stock_status, expiry_sort_key);
create unique index inventory_lot_balances_organization_id_and_lot_id_and__045b7c79 on inventory_lot_balances (organization_id, lot_id, location_id, stock_status);
create index inventory_lot_balances_organization_id_and_lot_id_idx on inventory_lot_balances (organization_id, lot_id);
create index inventory_lot_balances_organization_id_and_location_id_61f331c8 on inventory_lot_balances (organization_id, location_id, product_id);
create trigger inventory_lot_balances_set_updated_at before update on inventory_lot_balances for each row execute function set_updated_at();

-- inventoryCommands
create table inventory_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  idempotency_key text not null,
  command_type text not null,
  schema_version integer not null,
  payload_hash text not null,
  actor_subject text not null,
  device_id text,
  status text not null check (status in ('posted', 'rejected', 'review_required')),
  source_document_id text,
  movement_id uuid,
  result jsonb,
  error_code text,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inventory_commands_organization_id_and_idempotency_key_key on inventory_commands (organization_id, idempotency_key);
create trigger inventory_commands_set_updated_at before update on inventory_commands for each row execute function set_updated_at();

-- inventoryMovementLines
create table inventory_movement_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  movement_id uuid not null,
  line_number integer not null,
  product_id uuid not null,
  base_uom_id uuid,
  quantity_base bigint not null,
  entered_quantity text,
  entered_uom_code text,
  from_location_id uuid,
  to_location_id uuid,
  from_stock_status text check (from_stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  to_stock_status text check (to_stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  source_line_id text,
  unit_cost_minor bigint,
  total_cost_minor bigint,
  reason_code text,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inventory_movement_lines_organization_id_and_movement__3dd71e7c on inventory_movement_lines (organization_id, movement_id, line_number);
create index inventory_movement_lines_organization_id_and_product_i_703fda15 on inventory_movement_lines (organization_id, product_id, effective_at);
create index inventory_movement_lines_organization_id_and_source_line_id_idx on inventory_movement_lines (organization_id, source_line_id);
create trigger inventory_movement_lines_set_updated_at before update on inventory_movement_lines for each row execute function set_updated_at();

-- inventoryAllocations
create table inventory_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  movement_id uuid not null,
  movement_line_id uuid not null,
  product_id uuid not null,
  lot_id uuid not null,
  quantity_base bigint not null,
  from_location_id uuid,
  to_location_id uuid,
  from_stock_status text check (from_stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  to_stock_status text check (to_stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  allocation_sequence integer not null,
  allocation_policy text not null check (allocation_policy in ('fefo', 'fifo', 'explicit_only')),
  user_selected boolean not null,
  reverses_allocation_id uuid,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_allocations_organization_id_and_movement_line_id_idx on inventory_allocations (organization_id, movement_line_id);
create index inventory_allocations_organization_id_and_lot_id_and_e_e4fbd6d8 on inventory_allocations (organization_id, lot_id, effective_at);
create index inventory_allocations_organization_id_and_reverses_all_186f2dea on inventory_allocations (organization_id, reverses_allocation_id);
create trigger inventory_allocations_set_updated_at before update on inventory_allocations for each row execute function set_updated_at();

-- inventoryLedgerEntries
create table inventory_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  movement_id uuid not null,
  movement_line_id uuid not null,
  allocation_id uuid,
  product_id uuid not null,
  lot_id uuid,
  location_id uuid not null,
  stock_status text not null check (stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  quantity_delta_base bigint not null,
  reserved_delta_base bigint not null,
  value_delta_minor bigint,
  balance_version integer not null,
  quantity_before_base bigint not null,
  quantity_after_base bigint not null,
  effective_at timestamptz not null,
  posted_at timestamptz not null,
  reverses_entry_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_ledger_entries_organization_id_and_movement_id_idx on inventory_ledger_entries (organization_id, movement_id);
create index inventory_ledger_entries_organization_id_and_product_i_3b8b5655 on inventory_ledger_entries (organization_id, product_id, location_id, effective_at);
create index inventory_ledger_entries_organization_id_and_lot_id_an_47534540 on inventory_ledger_entries (organization_id, lot_id, location_id, effective_at);
create trigger inventory_ledger_entries_set_updated_at before update on inventory_ledger_entries for each row execute function set_updated_at();

-- inventoryReservations
create table inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  reservation_number text not null,
  reservation_type text not null,
  source_type text not null,
  source_document_id text not null,
  status text not null check (status in ('active', 'partially_consumed', 'consumed', 'released', 'expired', 'cancelled')),
  expires_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_reservations_organization_id_and_source_type_d518865f on inventory_reservations (organization_id, source_type, source_document_id);
create index inventory_reservations_organization_id_and_status_and__efae2414 on inventory_reservations (organization_id, status, expires_at);
create trigger inventory_reservations_set_updated_at before update on inventory_reservations for each row execute function set_updated_at();

-- inventoryReservationLines
create table inventory_reservation_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  reservation_id uuid not null,
  product_id uuid not null,
  location_id uuid not null,
  lot_id uuid,
  requested_base bigint not null,
  reserved_base bigint not null,
  consumed_base bigint not null,
  released_base bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_reservation_lines_organization_id_and_reserv_8d04b95f on inventory_reservation_lines (organization_id, reservation_id);
create index inventory_reservation_lines_organization_id_and_produc_01453e5b on inventory_reservation_lines (organization_id, product_id, location_id);
create trigger inventory_reservation_lines_set_updated_at before update on inventory_reservation_lines for each row execute function set_updated_at();

-- goodsReceipts
create table goods_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  receipt_number text not null,
  receipt_type text not null check (receipt_type in ('purchase_order', 'transfer', 'return', 'production', 'unplanned')),
  source_document_id text,
  receiving_location_id uuid not null,
  status text not null check (status in ('draft', 'in_inspection', 'partially_posted', 'posted', 'cancelled', 'review_required')),
  delivery_reference text,
  received_by text not null,
  movement_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index goods_receipts_organization_id_and_receipt_number_key on goods_receipts (organization_id, receipt_number);
create index goods_receipts_organization_id_and_status_and_created_at_idx on goods_receipts (organization_id, status, created_at);
create index goods_receipts_organization_id_and_source_document_id_idx on goods_receipts (organization_id, source_document_id);
create trigger goods_receipts_set_updated_at before update on goods_receipts for each row execute function set_updated_at();

-- goodsReceiptLines
create table goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  receipt_id uuid not null,
  source_line_id text,
  product_id uuid not null,
  accepted_base bigint not null,
  rejected_base bigint not null,
  lot_id uuid,
  destination_status text not null check (destination_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  unit_cost_minor bigint,
  movement_line_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index goods_receipt_lines_organization_id_and_receipt_id_idx on goods_receipt_lines (organization_id, receipt_id);
create index goods_receipt_lines_organization_id_and_source_line_id_idx on goods_receipt_lines (organization_id, source_line_id);
create trigger goods_receipt_lines_set_updated_at before update on goods_receipt_lines for each row execute function set_updated_at();

-- truckRouteSessions
create table truck_route_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  route_code text not null,
  truck_location_id uuid not null,
  salesperson_subject text not null,
  assigned_device_id text not null,
  status text not null check (status in ('planned', 'loading', 'open', 'closing', 'reconciling', 'closed', 'review_required')),
  opened_at timestamptz,
  closed_at timestamptz,
  last_acknowledged_sequence bigint not null,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index truck_route_sessions_organization_id_and_salesperson_s_932ced4a on truck_route_sessions (organization_id, salesperson_subject, status);
create index truck_route_sessions_organization_id_and_assigned_devi_118d3fd0 on truck_route_sessions (organization_id, assigned_device_id, status);
create index truck_route_sessions_organization_id_and_truck_locatio_008332c5 on truck_route_sessions (organization_id, truck_location_id, status);
create trigger truck_route_sessions_set_updated_at before update on truck_route_sessions for each row execute function set_updated_at();

-- stockTransfers
create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  transfer_number text not null,
  source_location_id uuid not null,
  destination_location_id uuid not null,
  in_transit_location_id uuid not null,
  status text not null check (status in ('draft', 'requested', 'approved', 'reserved', 'picking', 'shipped', 'partially_received', 'received', 'cancelled', 'review_required')),
  requested_by text not null,
  approved_by text,
  shipped_by text,
  received_by text,
  route_session_id uuid,
  outbound_movement_id uuid,
  receipt_movement_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index stock_transfers_organization_id_and_transfer_number_key on stock_transfers (organization_id, transfer_number);
create index stock_transfers_organization_id_and_status_and_created_at_idx on stock_transfers (organization_id, status, created_at);
create index stock_transfers_organization_id_and_source_location_id_e24e4d21 on stock_transfers (organization_id, source_location_id, status);
create index stock_transfers_organization_id_and_destination_locati_ec9a2f36 on stock_transfers (organization_id, destination_location_id, status);
create trigger stock_transfers_set_updated_at before update on stock_transfers for each row execute function set_updated_at();

-- stockTransferLines
create table stock_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  transfer_id uuid not null,
  product_id uuid not null,
  requested_base bigint not null,
  approved_base bigint not null,
  shipped_base bigint not null,
  received_base bigint not null,
  rejected_base bigint not null,
  short_base bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stock_transfer_lines_organization_id_and_transfer_id_idx on stock_transfer_lines (organization_id, transfer_id);
create trigger stock_transfer_lines_set_updated_at before update on stock_transfer_lines for each row execute function set_updated_at();

-- stockCountSessions
create table stock_count_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  count_number text not null,
  count_type text not null check (count_type in ('cycle', 'full', 'spot', 'route_close')),
  location_id uuid not null,
  status text not null check (status in ('draft', 'frozen', 'counting', 'submitted', 'reviewed', 'approved', 'posted', 'cancelled')),
  blind_count boolean not null,
  snapshot_at timestamptz not null,
  created_by text not null,
  approved_by text,
  adjustment_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index stock_count_sessions_organization_id_and_count_number_key on stock_count_sessions (organization_id, count_number);
create index stock_count_sessions_organization_id_and_location_id_a_75fc8311 on stock_count_sessions (organization_id, location_id, status);
create trigger stock_count_sessions_set_updated_at before update on stock_count_sessions for each row execute function set_updated_at();

-- stockCountLines
create table stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  session_id uuid not null,
  product_id uuid not null,
  lot_id uuid,
  stock_status text not null check (stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  system_base bigint not null,
  snapshot_balance_version integer,
  snapshot_movement_id uuid,
  counted_base bigint,
  variance_base bigint,
  finding text check (finding in ('over', 'missing', 'damaged', 'expired', 'wrong_lot', 'wrong_location')),
  note text,
  counted_by text,
  counted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stock_count_lines_organization_id_and_session_id_idx on stock_count_lines (organization_id, session_id);
create trigger stock_count_lines_set_updated_at before update on stock_count_lines for each row execute function set_updated_at();

-- inventoryAdjustments
create table inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  adjustment_number text not null,
  adjustment_type text not null,
  reason_code text not null,
  source_count_id uuid,
  status text not null check (status in ('draft', 'submitted', 'approved', 'posted', 'rejected', 'reversed')),
  requested_by text not null,
  approved_by text,
  movement_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inventory_adjustments_organization_id_and_adjustment_number_key on inventory_adjustments (organization_id, adjustment_number);
create index inventory_adjustments_organization_id_and_status_and_c_79b63b58 on inventory_adjustments (organization_id, status, created_at);
create trigger inventory_adjustments_set_updated_at before update on inventory_adjustments for each row execute function set_updated_at();

-- inventoryAdjustmentLines
create table inventory_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  adjustment_id uuid not null,
  product_id uuid not null,
  lot_id uuid,
  location_id uuid not null,
  stock_status text not null check (stock_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  variance_base bigint not null,
  unit_cost_minor bigint,
  reason_code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_adjustment_lines_organization_id_and_adjustm_a691318a on inventory_adjustment_lines (organization_id, adjustment_id);
create trigger inventory_adjustment_lines_set_updated_at before update on inventory_adjustment_lines for each row execute function set_updated_at();

-- billOfMaterials
create table bill_of_materials (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid not null,
  code text not null,
  name text not null,
  active boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bill_of_materials_organization_id_and_code_key on bill_of_materials (organization_id, code);
create index bill_of_materials_organization_id_and_product_id_idx on bill_of_materials (organization_id, product_id);
create trigger bill_of_materials_set_updated_at before update on bill_of_materials for each row execute function set_updated_at();

-- billOfMaterialVersions
create table bill_of_material_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  bom_id uuid not null,
  version integer not null,
  output_quantity_base bigint not null,
  status text not null check (status in ('draft', 'approved', 'active', 'obsolete')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  yield_target_bps integer not null,
  created_by text,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bill_of_material_versions_organization_id_and_bom_id_a_f1011197 on bill_of_material_versions (organization_id, bom_id, version);
create trigger bill_of_material_versions_set_updated_at before update on bill_of_material_versions for each row execute function set_updated_at();

-- billOfMaterialComponents
create table bill_of_material_components (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  bom_version_id uuid not null,
  component_product_id uuid not null,
  quantity_base bigint not null,
  issue_policy text not null check (issue_policy in ('backflush', 'manual_issue', 'staged')),
  scrap_allowance_bps integer not null,
  optional boolean not null,
  preferred_location_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bill_of_material_components_organization_id_and_bom_ve_4f32aa4d on bill_of_material_components (organization_id, bom_version_id);
create trigger bill_of_material_components_set_updated_at before update on bill_of_material_components for each row execute function set_updated_at();

-- productionOrders
create table production_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  production_order_number text not null,
  product_id uuid not null,
  bom_version_id uuid not null,
  planned_base bigint not null,
  completed_base bigint not null,
  scrapped_base bigint not null,
  source_location_id uuid not null,
  wip_location_id uuid not null,
  output_location_id uuid not null,
  status text not null check (status in ('draft', 'released', 'material_staged', 'in_progress', 'partially_completed', 'completed', 'cancelled', 'closed', 'review_required')),
  created_by text not null,
  released_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index production_orders_organization_id_and_production_order_defdecea on production_orders (organization_id, production_order_number);
create index production_orders_organization_id_and_status_and_created_at_idx on production_orders (organization_id, status, created_at);
create trigger production_orders_set_updated_at before update on production_orders for each row execute function set_updated_at();

-- productionMaterialIssues
create table production_material_issues (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  production_order_id uuid not null,
  movement_id uuid not null,
  issue_type text not null check (issue_type in ('issue', 'return')),
  posted_by text not null,
  posted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index production_material_issues_organization_id_and_product_f3d5beca on production_material_issues (organization_id, production_order_id);
create trigger production_material_issues_set_updated_at before update on production_material_issues for each row execute function set_updated_at();

-- productionOutputReceipts
create table production_output_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  production_order_id uuid not null,
  output_lot_id uuid not null,
  quantity_base bigint not null,
  movement_id uuid not null,
  quality_status text not null check (quality_status in ('available', 'quality_hold', 'quarantine', 'damaged', 'expired', 'rejected', 'wip', 'in_transit')),
  posted_by text not null,
  posted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index production_output_receipts_organization_id_and_product_e6c73c04 on production_output_receipts (organization_id, production_order_id);
create trigger production_output_receipts_set_updated_at before update on production_output_receipts for each row execute function set_updated_at();

-- lotGenealogyLinks
create table lot_genealogy_links (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  production_order_id uuid not null,
  output_lot_id uuid not null,
  component_lot_id uuid not null,
  component_product_id uuid not null,
  quantity_base bigint not null,
  movement_id uuid not null,
  movement_line_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lot_genealogy_links_organization_id_and_output_lot_id_idx on lot_genealogy_links (organization_id, output_lot_id);
create index lot_genealogy_links_organization_id_and_component_lot_id_idx on lot_genealogy_links (organization_id, component_lot_id);
create index lot_genealogy_links_organization_id_and_production_order_id_idx on lot_genealogy_links (organization_id, production_order_id);
create trigger lot_genealogy_links_set_updated_at before update on lot_genealogy_links for each row execute function set_updated_at();

-- truckInventoryCheckpoints
create table truck_inventory_checkpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  route_session_id uuid not null,
  checkpoint_number integer not null,
  server_sequence bigint not null,
  checksum text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index truck_inventory_checkpoints_organization_id_and_route__66839988 on truck_inventory_checkpoints (organization_id, route_session_id, checkpoint_number);
create trigger truck_inventory_checkpoints_set_updated_at before update on truck_inventory_checkpoints for each row execute function set_updated_at();

-- truckInventoryCheckpointLines
create table truck_inventory_checkpoint_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  checkpoint_id uuid not null,
  product_id uuid not null,
  lot_id uuid,
  quantity_base bigint not null,
  balance_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index truck_inventory_checkpoint_lines_organization_id_and_c_0fbc7db5 on truck_inventory_checkpoint_lines (organization_id, checkpoint_id);
create trigger truck_inventory_checkpoint_lines_set_updated_at before update on truck_inventory_checkpoint_lines for each row execute function set_updated_at();

-- negativeStockAllowances [synced]
create table negative_stock_allowances (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  location_id uuid not null,
  operation text not null check (operation in ('distributor')),
  movement_types text[] default '{}' not null check (movement_types <@ array['pos_sale', 'inventory_issue', 'transfer_ship']::text[]),
  limit_base bigint,
  active boolean not null,
  source_ref text not null,
  version integer not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index negative_stock_allowances_organization_id_and_location_id_key on negative_stock_allowances (organization_id, location_id);
create index negative_stock_allowances_change_seq_idx on negative_stock_allowances (change_seq);
create trigger negative_stock_allowances_bump_change_seq before update on negative_stock_allowances for each row execute function bump_change_seq();

-- negativeStockFlags
create table negative_stock_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  allowance_id uuid not null,
  movement_id uuid not null,
  movement_type text not null check (movement_type in ('pos_sale', 'inventory_issue', 'transfer_ship')),
  product_id uuid not null,
  location_id uuid not null,
  quantity_base bigint not null,
  balance_after_base bigint not null,
  shortfall_base bigint not null,
  status text not null check (status in ('open', 'resolved')),
  posted_by text not null,
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index negative_stock_flags_organization_id_and_status_and_cr_c8b10be6 on negative_stock_flags (organization_id, status, created_at);
create index negative_stock_flags_organization_id_and_movement_id_idx on negative_stock_flags (organization_id, movement_id);
create trigger negative_stock_flags_set_updated_at before update on negative_stock_flags for each row execute function set_updated_at();

-- inventoryReconciliationRuns
create table inventory_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  scope text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed')),
  convex_cutoff timestamptz not null,
  sap_cutoff timestamptz not null,
  compared_count integer not null,
  difference_count integer not null,
  started_by text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_reconciliation_runs_organization_id_and_stat_7160a47c on inventory_reconciliation_runs (organization_id, status, started_at);
create trigger inventory_reconciliation_runs_set_updated_at before update on inventory_reconciliation_runs for each row execute function set_updated_at();

-- inventoryReconciliationDifferences
create table inventory_reconciliation_differences (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  run_id uuid not null,
  product_id uuid,
  location_id uuid,
  product_code text not null,
  warehouse_code text not null,
  convex_base bigint not null,
  sap_base bigint not null,
  difference_base bigint not null,
  classification text not null check (classification in ('mapping', 'timing', 'missing_inbound', 'missing_outbound', 'duplicate', 'unauthorized_adjustment', 'unresolved')),
  resolution_status text not null check (resolution_status in ('open', 'resolved', 'accepted')),
  note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_reconciliation_differences_organization_id_a_dea5cc75 on inventory_reconciliation_differences (organization_id, run_id);
create index inventory_reconciliation_differences_organization_id_a_40b974ae on inventory_reconciliation_differences (organization_id, resolution_status, created_at);
create trigger inventory_reconciliation_differences_set_updated_at before update on inventory_reconciliation_differences for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table inventory_locations add constraint inventory_locations_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table inventory_locations add constraint inventory_locations_warehouse_id_fkey foreign key (warehouse_id) references warehouses(id);
alter table inventory_locations add constraint inventory_locations_parent_location_id_fkey foreign key (parent_location_id) references inventory_locations(id);
alter table product_inventory_policies add constraint product_inventory_policies_product_id_fkey foreign key (product_id) references products(id);
alter table product_inventory_policies add constraint product_inventory_policies_base_uom_id_fkey foreign key (base_uom_id) references units_of_measure(id);
alter table replenishment_policies add constraint replenishment_policies_product_id_fkey foreign key (product_id) references products(id);
alter table replenishment_policies add constraint replenishment_policies_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table inventory_movements add constraint inventory_movements_reverses_movement_id_fkey foreign key (reverses_movement_id) references inventory_movements(id);
alter table inventory_movements add constraint inventory_movements_reversed_by_movement_id_fkey foreign key (reversed_by_movement_id) references inventory_movements(id);
alter table inventory_balances add constraint inventory_balances_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_balances add constraint inventory_balances_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table inventory_balances add constraint inventory_balances_last_movement_id_fkey foreign key (last_movement_id) references inventory_movements(id);
alter table inventory_lots add constraint inventory_lots_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_lot_balances add constraint inventory_lot_balances_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_lot_balances add constraint inventory_lot_balances_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table inventory_lot_balances add constraint inventory_lot_balances_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table inventory_lot_balances add constraint inventory_lot_balances_last_movement_id_fkey foreign key (last_movement_id) references inventory_movements(id);
alter table inventory_commands add constraint inventory_commands_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table inventory_movement_lines add constraint inventory_movement_lines_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table inventory_movement_lines add constraint inventory_movement_lines_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_movement_lines add constraint inventory_movement_lines_base_uom_id_fkey foreign key (base_uom_id) references units_of_measure(id);
alter table inventory_movement_lines add constraint inventory_movement_lines_from_location_id_fkey foreign key (from_location_id) references inventory_locations(id);
alter table inventory_movement_lines add constraint inventory_movement_lines_to_location_id_fkey foreign key (to_location_id) references inventory_locations(id);
alter table inventory_allocations add constraint inventory_allocations_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table inventory_allocations add constraint inventory_allocations_movement_line_id_fkey foreign key (movement_line_id) references inventory_movement_lines(id);
alter table inventory_allocations add constraint inventory_allocations_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_allocations add constraint inventory_allocations_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table inventory_allocations add constraint inventory_allocations_from_location_id_fkey foreign key (from_location_id) references inventory_locations(id);
alter table inventory_allocations add constraint inventory_allocations_to_location_id_fkey foreign key (to_location_id) references inventory_locations(id);
alter table inventory_allocations add constraint inventory_allocations_reverses_allocation_id_fkey foreign key (reverses_allocation_id) references inventory_allocations(id);
alter table inventory_ledger_entries add constraint inventory_ledger_entries_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table inventory_ledger_entries add constraint inventory_ledger_entries_movement_line_id_fkey foreign key (movement_line_id) references inventory_movement_lines(id);
alter table inventory_ledger_entries add constraint inventory_ledger_entries_allocation_id_fkey foreign key (allocation_id) references inventory_allocations(id);
alter table inventory_ledger_entries add constraint inventory_ledger_entries_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_ledger_entries add constraint inventory_ledger_entries_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table inventory_ledger_entries add constraint inventory_ledger_entries_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table inventory_ledger_entries add constraint inventory_ledger_entries_reverses_entry_id_fkey foreign key (reverses_entry_id) references inventory_ledger_entries(id);
alter table inventory_reservation_lines add constraint inventory_reservation_lines_reservation_id_fkey foreign key (reservation_id) references inventory_reservations(id);
alter table inventory_reservation_lines add constraint inventory_reservation_lines_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_reservation_lines add constraint inventory_reservation_lines_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table inventory_reservation_lines add constraint inventory_reservation_lines_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table goods_receipts add constraint goods_receipts_receiving_location_id_fkey foreign key (receiving_location_id) references inventory_locations(id);
alter table goods_receipts add constraint goods_receipts_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table goods_receipt_lines add constraint goods_receipt_lines_receipt_id_fkey foreign key (receipt_id) references goods_receipts(id);
alter table goods_receipt_lines add constraint goods_receipt_lines_product_id_fkey foreign key (product_id) references products(id);
alter table goods_receipt_lines add constraint goods_receipt_lines_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table goods_receipt_lines add constraint goods_receipt_lines_movement_line_id_fkey foreign key (movement_line_id) references inventory_movement_lines(id);
alter table truck_route_sessions add constraint truck_route_sessions_truck_location_id_fkey foreign key (truck_location_id) references inventory_locations(id);
alter table stock_transfers add constraint stock_transfers_source_location_id_fkey foreign key (source_location_id) references inventory_locations(id);
alter table stock_transfers add constraint stock_transfers_destination_location_id_fkey foreign key (destination_location_id) references inventory_locations(id);
alter table stock_transfers add constraint stock_transfers_in_transit_location_id_fkey foreign key (in_transit_location_id) references inventory_locations(id);
alter table stock_transfers add constraint stock_transfers_route_session_id_fkey foreign key (route_session_id) references truck_route_sessions(id);
alter table stock_transfers add constraint stock_transfers_outbound_movement_id_fkey foreign key (outbound_movement_id) references inventory_movements(id);
alter table stock_transfers add constraint stock_transfers_receipt_movement_id_fkey foreign key (receipt_movement_id) references inventory_movements(id);
alter table stock_transfer_lines add constraint stock_transfer_lines_transfer_id_fkey foreign key (transfer_id) references stock_transfers(id);
alter table stock_transfer_lines add constraint stock_transfer_lines_product_id_fkey foreign key (product_id) references products(id);
alter table stock_count_sessions add constraint stock_count_sessions_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table stock_count_sessions add constraint stock_count_sessions_adjustment_id_fkey foreign key (adjustment_id) references inventory_adjustments(id);
alter table stock_count_lines add constraint stock_count_lines_session_id_fkey foreign key (session_id) references stock_count_sessions(id);
alter table stock_count_lines add constraint stock_count_lines_product_id_fkey foreign key (product_id) references products(id);
alter table stock_count_lines add constraint stock_count_lines_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table stock_count_lines add constraint stock_count_lines_snapshot_movement_id_fkey foreign key (snapshot_movement_id) references inventory_movements(id);
alter table inventory_adjustments add constraint inventory_adjustments_source_count_id_fkey foreign key (source_count_id) references stock_count_sessions(id);
alter table inventory_adjustments add constraint inventory_adjustments_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table inventory_adjustment_lines add constraint inventory_adjustment_lines_adjustment_id_fkey foreign key (adjustment_id) references inventory_adjustments(id);
alter table inventory_adjustment_lines add constraint inventory_adjustment_lines_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_adjustment_lines add constraint inventory_adjustment_lines_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table inventory_adjustment_lines add constraint inventory_adjustment_lines_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table bill_of_materials add constraint bill_of_materials_product_id_fkey foreign key (product_id) references products(id);
alter table bill_of_material_versions add constraint bill_of_material_versions_bom_id_fkey foreign key (bom_id) references bill_of_materials(id);
alter table bill_of_material_components add constraint bill_of_material_components_bom_version_id_fkey foreign key (bom_version_id) references bill_of_material_versions(id);
alter table bill_of_material_components add constraint bill_of_material_components_component_product_id_fkey foreign key (component_product_id) references products(id);
alter table bill_of_material_components add constraint bill_of_material_components_preferred_location_id_fkey foreign key (preferred_location_id) references inventory_locations(id);
alter table production_orders add constraint production_orders_product_id_fkey foreign key (product_id) references products(id);
alter table production_orders add constraint production_orders_bom_version_id_fkey foreign key (bom_version_id) references bill_of_material_versions(id);
alter table production_orders add constraint production_orders_source_location_id_fkey foreign key (source_location_id) references inventory_locations(id);
alter table production_orders add constraint production_orders_wip_location_id_fkey foreign key (wip_location_id) references inventory_locations(id);
alter table production_orders add constraint production_orders_output_location_id_fkey foreign key (output_location_id) references inventory_locations(id);
alter table production_material_issues add constraint production_material_issues_production_order_id_fkey foreign key (production_order_id) references production_orders(id);
alter table production_material_issues add constraint production_material_issues_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table production_output_receipts add constraint production_output_receipts_production_order_id_fkey foreign key (production_order_id) references production_orders(id);
alter table production_output_receipts add constraint production_output_receipts_output_lot_id_fkey foreign key (output_lot_id) references inventory_lots(id);
alter table production_output_receipts add constraint production_output_receipts_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table lot_genealogy_links add constraint lot_genealogy_links_production_order_id_fkey foreign key (production_order_id) references production_orders(id);
alter table lot_genealogy_links add constraint lot_genealogy_links_output_lot_id_fkey foreign key (output_lot_id) references inventory_lots(id);
alter table lot_genealogy_links add constraint lot_genealogy_links_component_lot_id_fkey foreign key (component_lot_id) references inventory_lots(id);
alter table lot_genealogy_links add constraint lot_genealogy_links_component_product_id_fkey foreign key (component_product_id) references products(id);
alter table lot_genealogy_links add constraint lot_genealogy_links_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table lot_genealogy_links add constraint lot_genealogy_links_movement_line_id_fkey foreign key (movement_line_id) references inventory_movement_lines(id);
alter table truck_inventory_checkpoints add constraint truck_inventory_checkpoints_route_session_id_fkey foreign key (route_session_id) references truck_route_sessions(id);
alter table truck_inventory_checkpoint_lines add constraint truck_inventory_checkpoint_lines_checkpoint_id_fkey foreign key (checkpoint_id) references truck_inventory_checkpoints(id);
alter table truck_inventory_checkpoint_lines add constraint truck_inventory_checkpoint_lines_product_id_fkey foreign key (product_id) references products(id);
alter table truck_inventory_checkpoint_lines add constraint truck_inventory_checkpoint_lines_lot_id_fkey foreign key (lot_id) references inventory_lots(id);
alter table negative_stock_allowances add constraint negative_stock_allowances_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table negative_stock_flags add constraint negative_stock_flags_allowance_id_fkey foreign key (allowance_id) references negative_stock_allowances(id);
alter table negative_stock_flags add constraint negative_stock_flags_movement_id_fkey foreign key (movement_id) references inventory_movements(id);
alter table negative_stock_flags add constraint negative_stock_flags_product_id_fkey foreign key (product_id) references products(id);
alter table negative_stock_flags add constraint negative_stock_flags_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table inventory_reconciliation_differences add constraint inventory_reconciliation_differences_run_id_fkey foreign key (run_id) references inventory_reconciliation_runs(id);
alter table inventory_reconciliation_differences add constraint inventory_reconciliation_differences_product_id_fkey foreign key (product_id) references products(id);
alter table inventory_reconciliation_differences add constraint inventory_reconciliation_differences_location_id_fkey foreign key (location_id) references inventory_locations(id);

-- Supporting indexes for foreign keys without a leading index.
create index inventory_locations_warehouse_id_fk_idx on inventory_locations (warehouse_id);
create index inventory_locations_parent_location_id_fk_idx on inventory_locations (parent_location_id);
create index product_inventory_policies_product_id_fk_idx on product_inventory_policies (product_id);
create index product_inventory_policies_base_uom_id_fk_idx on product_inventory_policies (base_uom_id);
create index replenishment_policies_product_id_fk_idx on replenishment_policies (product_id);
create index replenishment_policies_location_id_fk_idx on replenishment_policies (location_id);
create index inventory_movements_reverses_movement_id_fk_idx on inventory_movements (reverses_movement_id);
create index inventory_movements_reversed_by_movement_id_fk_idx on inventory_movements (reversed_by_movement_id);
create index inventory_balances_product_id_fk_idx on inventory_balances (product_id);
create index inventory_balances_location_id_fk_idx on inventory_balances (location_id);
create index inventory_balances_last_movement_id_fk_idx on inventory_balances (last_movement_id);
create index inventory_lots_product_id_fk_idx on inventory_lots (product_id);
create index inventory_lot_balances_product_id_fk_idx on inventory_lot_balances (product_id);
create index inventory_lot_balances_lot_id_fk_idx on inventory_lot_balances (lot_id);
create index inventory_lot_balances_location_id_fk_idx on inventory_lot_balances (location_id);
create index inventory_lot_balances_last_movement_id_fk_idx on inventory_lot_balances (last_movement_id);
create index inventory_commands_movement_id_fk_idx on inventory_commands (movement_id);
create index inventory_movement_lines_movement_id_fk_idx on inventory_movement_lines (movement_id);
create index inventory_movement_lines_product_id_fk_idx on inventory_movement_lines (product_id);
create index inventory_movement_lines_base_uom_id_fk_idx on inventory_movement_lines (base_uom_id);
create index inventory_movement_lines_from_location_id_fk_idx on inventory_movement_lines (from_location_id);
create index inventory_movement_lines_to_location_id_fk_idx on inventory_movement_lines (to_location_id);
create index inventory_allocations_movement_id_fk_idx on inventory_allocations (movement_id);
create index inventory_allocations_movement_line_id_fk_idx on inventory_allocations (movement_line_id);
create index inventory_allocations_product_id_fk_idx on inventory_allocations (product_id);
create index inventory_allocations_lot_id_fk_idx on inventory_allocations (lot_id);
create index inventory_allocations_from_location_id_fk_idx on inventory_allocations (from_location_id);
create index inventory_allocations_to_location_id_fk_idx on inventory_allocations (to_location_id);
create index inventory_allocations_reverses_allocation_id_fk_idx on inventory_allocations (reverses_allocation_id);
create index inventory_ledger_entries_movement_id_fk_idx on inventory_ledger_entries (movement_id);
create index inventory_ledger_entries_movement_line_id_fk_idx on inventory_ledger_entries (movement_line_id);
create index inventory_ledger_entries_allocation_id_fk_idx on inventory_ledger_entries (allocation_id);
create index inventory_ledger_entries_product_id_fk_idx on inventory_ledger_entries (product_id);
create index inventory_ledger_entries_lot_id_fk_idx on inventory_ledger_entries (lot_id);
create index inventory_ledger_entries_location_id_fk_idx on inventory_ledger_entries (location_id);
create index inventory_ledger_entries_reverses_entry_id_fk_idx on inventory_ledger_entries (reverses_entry_id);
create index inventory_reservation_lines_reservation_id_fk_idx on inventory_reservation_lines (reservation_id);
create index inventory_reservation_lines_product_id_fk_idx on inventory_reservation_lines (product_id);
create index inventory_reservation_lines_location_id_fk_idx on inventory_reservation_lines (location_id);
create index inventory_reservation_lines_lot_id_fk_idx on inventory_reservation_lines (lot_id);
create index goods_receipts_receiving_location_id_fk_idx on goods_receipts (receiving_location_id);
create index goods_receipts_movement_id_fk_idx on goods_receipts (movement_id);
create index goods_receipt_lines_receipt_id_fk_idx on goods_receipt_lines (receipt_id);
create index goods_receipt_lines_product_id_fk_idx on goods_receipt_lines (product_id);
create index goods_receipt_lines_lot_id_fk_idx on goods_receipt_lines (lot_id);
create index goods_receipt_lines_movement_line_id_fk_idx on goods_receipt_lines (movement_line_id);
create index truck_route_sessions_truck_location_id_fk_idx on truck_route_sessions (truck_location_id);
create index stock_transfers_source_location_id_fk_idx on stock_transfers (source_location_id);
create index stock_transfers_destination_location_id_fk_idx on stock_transfers (destination_location_id);
create index stock_transfers_in_transit_location_id_fk_idx on stock_transfers (in_transit_location_id);
create index stock_transfers_route_session_id_fk_idx on stock_transfers (route_session_id);
create index stock_transfers_outbound_movement_id_fk_idx on stock_transfers (outbound_movement_id);
create index stock_transfers_receipt_movement_id_fk_idx on stock_transfers (receipt_movement_id);
create index stock_transfer_lines_transfer_id_fk_idx on stock_transfer_lines (transfer_id);
create index stock_transfer_lines_product_id_fk_idx on stock_transfer_lines (product_id);
create index stock_count_sessions_location_id_fk_idx on stock_count_sessions (location_id);
create index stock_count_sessions_adjustment_id_fk_idx on stock_count_sessions (adjustment_id);
create index stock_count_lines_session_id_fk_idx on stock_count_lines (session_id);
create index stock_count_lines_product_id_fk_idx on stock_count_lines (product_id);
create index stock_count_lines_lot_id_fk_idx on stock_count_lines (lot_id);
create index stock_count_lines_snapshot_movement_id_fk_idx on stock_count_lines (snapshot_movement_id);
create index inventory_adjustments_source_count_id_fk_idx on inventory_adjustments (source_count_id);
create index inventory_adjustments_movement_id_fk_idx on inventory_adjustments (movement_id);
create index inventory_adjustment_lines_adjustment_id_fk_idx on inventory_adjustment_lines (adjustment_id);
create index inventory_adjustment_lines_product_id_fk_idx on inventory_adjustment_lines (product_id);
create index inventory_adjustment_lines_lot_id_fk_idx on inventory_adjustment_lines (lot_id);
create index inventory_adjustment_lines_location_id_fk_idx on inventory_adjustment_lines (location_id);
create index bill_of_materials_product_id_fk_idx on bill_of_materials (product_id);
create index bill_of_material_versions_bom_id_fk_idx on bill_of_material_versions (bom_id);
create index bill_of_material_components_bom_version_id_fk_idx on bill_of_material_components (bom_version_id);
create index bill_of_material_components_component_product_id_fk_idx on bill_of_material_components (component_product_id);
create index bill_of_material_components_preferred_location_id_fk_idx on bill_of_material_components (preferred_location_id);
create index production_orders_product_id_fk_idx on production_orders (product_id);
create index production_orders_bom_version_id_fk_idx on production_orders (bom_version_id);
create index production_orders_source_location_id_fk_idx on production_orders (source_location_id);
create index production_orders_wip_location_id_fk_idx on production_orders (wip_location_id);
create index production_orders_output_location_id_fk_idx on production_orders (output_location_id);
create index production_material_issues_production_order_id_fk_idx on production_material_issues (production_order_id);
create index production_material_issues_movement_id_fk_idx on production_material_issues (movement_id);
create index production_output_receipts_production_order_id_fk_idx on production_output_receipts (production_order_id);
create index production_output_receipts_output_lot_id_fk_idx on production_output_receipts (output_lot_id);
create index production_output_receipts_movement_id_fk_idx on production_output_receipts (movement_id);
create index lot_genealogy_links_production_order_id_fk_idx on lot_genealogy_links (production_order_id);
create index lot_genealogy_links_output_lot_id_fk_idx on lot_genealogy_links (output_lot_id);
create index lot_genealogy_links_component_lot_id_fk_idx on lot_genealogy_links (component_lot_id);
create index lot_genealogy_links_component_product_id_fk_idx on lot_genealogy_links (component_product_id);
create index lot_genealogy_links_movement_id_fk_idx on lot_genealogy_links (movement_id);
create index lot_genealogy_links_movement_line_id_fk_idx on lot_genealogy_links (movement_line_id);
create index truck_inventory_checkpoints_route_session_id_fk_idx on truck_inventory_checkpoints (route_session_id);
create index truck_inventory_checkpoint_lines_checkpoint_id_fk_idx on truck_inventory_checkpoint_lines (checkpoint_id);
create index truck_inventory_checkpoint_lines_product_id_fk_idx on truck_inventory_checkpoint_lines (product_id);
create index truck_inventory_checkpoint_lines_lot_id_fk_idx on truck_inventory_checkpoint_lines (lot_id);
create index negative_stock_allowances_location_id_fk_idx on negative_stock_allowances (location_id);
create index negative_stock_flags_allowance_id_fk_idx on negative_stock_flags (allowance_id);
create index negative_stock_flags_movement_id_fk_idx on negative_stock_flags (movement_id);
create index negative_stock_flags_product_id_fk_idx on negative_stock_flags (product_id);
create index negative_stock_flags_location_id_fk_idx on negative_stock_flags (location_id);
create index inventory_reconciliation_differences_run_id_fk_idx on inventory_reconciliation_differences (run_id);
create index inventory_reconciliation_differences_product_id_fk_idx on inventory_reconciliation_differences (product_id);
create index inventory_reconciliation_differences_location_id_fk_idx on inventory_reconciliation_differences (location_id);
