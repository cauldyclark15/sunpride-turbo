-- 0109_pricing_orders: Price lists, promotions, orders, workflows.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: price_lists, price_list_lines, promotions, field_order_pricings, field_order_pricing_lines, orders, order_lines, outside_call_orders, outside_call_order_lines, visits, workflow_instances, approvals, metrics.

-- priceLists [synced]
create table price_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  name text not null,
  channel_key text,
  currency text not null,
  status text not null check (status in ('active', 'inactive')),
  source text not null check (source in ('sample', 'office')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index price_lists_organization_id_and_code_key on price_lists (organization_id, code);
create index price_lists_organization_id_and_channel_key_idx on price_lists (organization_id, channel_key);
create index price_lists_change_seq_idx on price_lists (change_seq);
create trigger price_lists_bump_change_seq before update on price_lists for each row execute function bump_change_seq();

-- priceListLines [synced]
create table price_list_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  price_list_id uuid not null,
  product_id uuid not null,
  uom text not null,
  unit_price_minor bigint not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint price_list_lines_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint price_list_lines_no_overlap exclude using gist (price_list_id with =, product_id with =, uom with =, tstzrange(effective_from, effective_to, '[)') with &&) where (deleted_at is null)
);
create index price_list_lines_price_list_id_and_product_id_idx on price_list_lines (price_list_id, product_id);
create index price_list_lines_change_seq_idx on price_list_lines (change_seq);
create trigger price_list_lines_bump_change_seq before update on price_list_lines for each row execute function bump_change_seq();

-- promotions [synced]
create table promotions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  name text not null,
  price_list_id uuid,
  rule_kind text not null check (rule_kind in ('buy_x_get_y', 'percent_off', 'bundle')),
  rule jsonb not null,
  status text not null check (status in ('active', 'inactive')),
  source text not null check (source in ('sample', 'office')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index promotions_organization_id_and_code_key on promotions (organization_id, code);
create index promotions_organization_id_and_status_idx on promotions (organization_id, status);
create index promotions_change_seq_idx on promotions (change_seq);
create trigger promotions_bump_change_seq before update on promotions for each row execute function bump_change_seq();

-- fieldOrderPricings [synced]
create table field_order_pricings (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  visit_id uuid not null,
  activity_id uuid not null,
  outlet_id uuid not null,
  customer_id uuid,
  client_order_id text not null,
  price_list_id uuid,
  price_list_source text check (price_list_source in ('sample', 'office')),
  currency text not null,
  priced_at timestamptz not null,
  total_minor bigint not null,
  unpriced_lines integer not null,
  credit_status text not null check (credit_status in ('within', 'over', 'no_limit', 'unknown')),
  credit_limit_minor bigint,
  credit_open_orders_minor bigint,
  server_time timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index field_order_pricings_activity_id_key on field_order_pricings (activity_id);
create index field_order_pricings_visit_id_idx on field_order_pricings (visit_id);
create index field_order_pricings_customer_id_and_server_time_idx on field_order_pricings (customer_id, server_time);
create index field_order_pricings_change_seq_idx on field_order_pricings (change_seq);
create trigger field_order_pricings_bump_change_seq before update on field_order_pricings for each row execute function bump_change_seq();

-- fieldOrderPricings (fieldOrderPricings.lines[]) [synced]
create table field_order_pricing_lines (
  id uuid primary key default gen_random_uuid(),
  field_order_pricing_id uuid not null,
  ordinal integer not null,
  product_id uuid not null,
  uom text not null,
  quantity numeric(14,3) not null,
  unit_price_minor bigint,
  line_total_minor bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index field_order_pricing_lines_parent_ordinal_key on field_order_pricing_lines (field_order_pricing_id, ordinal);
create index field_order_pricing_lines_change_seq_idx on field_order_pricing_lines (change_seq);
create trigger field_order_pricing_lines_bump_change_seq before update on field_order_pricing_lines for each row execute function bump_change_seq();

-- orders [synced]
create table orders (
  id uuid primary key default gen_random_uuid(),
  organization_id text,
  client_request_id text not null,
  order_number text not null,
  order_type text,
  customer_code text not null,
  salesperson_subject text not null,
  status text not null check (status in ('draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'sent_to_sap', 'fulfilled', 'posted', 'partially_voided', 'voided', 'returned', 'review_required')),
  subtotal numeric(14,2) not null,
  total numeric(14,2) not null,
  offline_created_at timestamptz,
  sap_document_number text,
  source_location_id uuid,
  route_session_id uuid,
  device_id text,
  inventory_movement_id uuid,
  request_payload_hash text,
  device_sequence bigint,
  void_movement_id uuid,
  original_order_id uuid,
  voided_at timestamptz,
  voided_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index orders_client_request_key on orders (client_request_id);
create index orders_status_idx on orders (status);
create index orders_customer_idx on orders (customer_code);
create index orders_created_at_idx on orders (created_at);
create index orders_salesperson_subject_and_created_at_idx on orders (salesperson_subject, created_at);
create unique index orders_order_number_key on orders (order_number);
create index orders_change_seq_idx on orders (change_seq);
create trigger orders_bump_change_seq before update on orders for each row execute function bump_change_seq();

-- orderLines [synced]
create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  product_code text not null,
  description text not null,
  quantity numeric(14,3) not null,
  unit_price numeric(14,2) not null,
  line_total numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index order_lines_order_idx on order_lines (order_id);
create index order_lines_change_seq_idx on order_lines (change_seq);
create trigger order_lines_bump_change_seq before update on order_lines for each row execute function bump_change_seq();

-- outsideCallOrders [synced]
create table outside_call_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  outlet_id uuid not null,
  territory_id uuid not null,
  customer_id uuid,
  salesperson_profile_id uuid not null,
  service_date date not null,
  po_number text not null,
  received_via text not null check (received_via in ('email', 'viber', 'phone', 'fax', 'other')),
  note text,
  status text not null check (status in ('awaiting_activity', 'activity_recorded', 'cancelled')),
  client_request_id text not null,
  encoded_by text not null,
  encoded_by_profile_id uuid not null,
  encoded_at timestamptz not null,
  activity_contact text check (activity_contact in ('phone', 'message', 'in_person', 'other')),
  activity_codes text[] default '{}' not null,
  activity_note text,
  activity_recorded_at timestamptz,
  cancelled_by_profile_id uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index outside_call_orders_encoded_by_profile_id_and_client_r_8fe31a1d on outside_call_orders (encoded_by_profile_id, client_request_id);
create index outside_call_orders_outlet_id_and_po_number_idx on outside_call_orders (outlet_id, po_number);
create index outside_call_orders_organization_id_and_status_and_enc_d06cdf11 on outside_call_orders (organization_id, status, encoded_at);
create index outside_call_orders_salesperson_profile_id_and_status__b74c014e on outside_call_orders (salesperson_profile_id, status, encoded_at);
create index outside_call_orders_salesperson_profile_id_and_service_date_idx on outside_call_orders (salesperson_profile_id, service_date);
create index outside_call_orders_change_seq_idx on outside_call_orders (change_seq);
create trigger outside_call_orders_bump_change_seq before update on outside_call_orders for each row execute function bump_change_seq();

-- outsideCallOrders (outsideCallOrders.lines[]) [synced]
create table outside_call_order_lines (
  id uuid primary key default gen_random_uuid(),
  outside_call_order_id uuid not null,
  ordinal integer not null,
  product_id uuid not null,
  product_code text not null,
  product_name text not null,
  quantity numeric(14,3) not null,
  uom text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index outside_call_order_lines_parent_ordinal_key on outside_call_order_lines (outside_call_order_id, ordinal);
create index outside_call_order_lines_change_seq_idx on outside_call_order_lines (change_seq);
create trigger outside_call_order_lines_bump_change_seq before update on outside_call_order_lines for each row execute function bump_change_seq();

-- visits
create table visits (
  id uuid primary key default gen_random_uuid(),
  salesperson_subject text not null,
  customer_code text not null,
  scheduled_at timestamptz not null,
  completed_at timestamptz,
  notes text,
  status text not null check (status in ('planned', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index visits_salesperson_time_idx on visits (salesperson_subject, scheduled_at);
create index visits_customer_idx on visits (customer_code);
create trigger visits_set_updated_at before update on visits for each row execute function set_updated_at();

-- workflowInstances
create table workflow_instances (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  workflow_type text not null,
  status text not null check (status in ('pending', 'approved', 'rejected')),
  current_step integer not null,
  requested_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workflow_instances_entity_idx on workflow_instances (entity_type, entity_id);
create index workflow_instances_status_idx on workflow_instances (status);
create trigger workflow_instances_set_updated_at before update on workflow_instances for each row execute function set_updated_at();

-- approvals
create table approvals (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null,
  approver_subject text,
  decision text not null check (decision in ('pending', 'approved', 'rejected')),
  comment text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index approvals_workflow_idx on approvals (workflow_id);
create index approvals_approver_idx on approvals (approver_subject);
create trigger approvals_set_updated_at before update on approvals for each row execute function set_updated_at();

-- metrics
create table metrics (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  product_count integer not null,
  customer_count integer not null,
  low_stock_count integer not null,
  open_order_count integer not null,
  pending_approval_count integer not null,
  sales_today numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index metrics_key_key on metrics (key);
create trigger metrics_set_updated_at before update on metrics for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table price_list_lines add constraint price_list_lines_price_list_id_fkey foreign key (price_list_id) references price_lists(id);
alter table price_list_lines add constraint price_list_lines_product_id_fkey foreign key (product_id) references products(id);
alter table promotions add constraint promotions_price_list_id_fkey foreign key (price_list_id) references price_lists(id);
alter table field_order_pricings add constraint field_order_pricings_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table field_order_pricings add constraint field_order_pricings_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table field_order_pricings add constraint field_order_pricings_activity_id_fkey foreign key (activity_id) references visit_activities(id);
alter table field_order_pricings add constraint field_order_pricings_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table field_order_pricings add constraint field_order_pricings_customer_id_fkey foreign key (customer_id) references customers(id);
alter table field_order_pricings add constraint field_order_pricings_price_list_id_fkey foreign key (price_list_id) references price_lists(id);
alter table field_order_pricing_lines add constraint field_order_pricing_lines_field_order_pricing_id_fkey foreign key (field_order_pricing_id) references field_order_pricings(id) on delete cascade;
alter table field_order_pricing_lines add constraint field_order_pricing_lines_product_id_fkey foreign key (product_id) references products(id);
alter table orders add constraint orders_source_location_id_fkey foreign key (source_location_id) references inventory_locations(id);
alter table orders add constraint orders_route_session_id_fkey foreign key (route_session_id) references truck_route_sessions(id);
alter table orders add constraint orders_inventory_movement_id_fkey foreign key (inventory_movement_id) references inventory_movements(id);
alter table orders add constraint orders_void_movement_id_fkey foreign key (void_movement_id) references inventory_movements(id);
alter table orders add constraint orders_original_order_id_fkey foreign key (original_order_id) references orders(id);
alter table order_lines add constraint order_lines_order_id_fkey foreign key (order_id) references orders(id);
alter table outside_call_orders add constraint outside_call_orders_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table outside_call_orders add constraint outside_call_orders_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table outside_call_orders add constraint outside_call_orders_territory_id_fkey foreign key (territory_id) references territories(id);
alter table outside_call_orders add constraint outside_call_orders_customer_id_fkey foreign key (customer_id) references customers(id);
alter table outside_call_orders add constraint outside_call_orders_salesperson_profile_id_fkey foreign key (salesperson_profile_id) references profiles(id);
alter table outside_call_orders add constraint outside_call_orders_encoded_by_profile_id_fkey foreign key (encoded_by_profile_id) references profiles(id);
alter table outside_call_orders add constraint outside_call_orders_cancelled_by_profile_id_fkey foreign key (cancelled_by_profile_id) references profiles(id);
alter table outside_call_order_lines add constraint outside_call_order_lines_outside_call_order_id_fkey foreign key (outside_call_order_id) references outside_call_orders(id) on delete cascade;
alter table outside_call_order_lines add constraint outside_call_order_lines_product_id_fkey foreign key (product_id) references products(id);
alter table approvals add constraint approvals_workflow_id_fkey foreign key (workflow_id) references workflow_instances(id);

-- Supporting indexes for foreign keys without a leading index.
create index price_list_lines_product_id_fk_idx on price_list_lines (product_id);
create index promotions_price_list_id_fk_idx on promotions (price_list_id);
create index field_order_pricings_org_unit_id_fk_idx on field_order_pricings (org_unit_id);
create index field_order_pricings_outlet_id_fk_idx on field_order_pricings (outlet_id);
create index field_order_pricings_price_list_id_fk_idx on field_order_pricings (price_list_id);
create index field_order_pricing_lines_product_id_fk_idx on field_order_pricing_lines (product_id);
create index orders_source_location_id_fk_idx on orders (source_location_id);
create index orders_route_session_id_fk_idx on orders (route_session_id);
create index orders_inventory_movement_id_fk_idx on orders (inventory_movement_id);
create index orders_void_movement_id_fk_idx on orders (void_movement_id);
create index orders_original_order_id_fk_idx on orders (original_order_id);
create index outside_call_orders_org_unit_id_fk_idx on outside_call_orders (org_unit_id);
create index outside_call_orders_territory_id_fk_idx on outside_call_orders (territory_id);
create index outside_call_orders_customer_id_fk_idx on outside_call_orders (customer_id);
create index outside_call_orders_cancelled_by_profile_id_fk_idx on outside_call_orders (cancelled_by_profile_id);
create index outside_call_order_lines_product_id_fk_idx on outside_call_order_lines (product_id);
