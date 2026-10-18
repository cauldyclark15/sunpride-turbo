-- 0108_integration: SAP integration events and snapshots.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: sap_inventory_snapshots, integration_events, connector_heartbeats.

-- sapInventorySnapshots
create table sap_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_code text not null,
  warehouse_code text not null,
  product_id uuid,
  location_id uuid,
  on_hand_base bigint not null,
  reserved_base bigint not null,
  available_base bigint not null,
  as_of timestamptz not null,
  source_event_id text not null,
  source_sequence text,
  payload_hash text,
  resolution_status text not null check (resolution_status in ('pending', 'matched', 'different', 'unmapped')),
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sap_inventory_snapshots_organization_id_and_product_co_aecdeee6 on sap_inventory_snapshots (organization_id, product_code, warehouse_code, as_of);
create unique index sap_inventory_snapshots_organization_id_and_source_event_id_key on sap_inventory_snapshots (organization_id, source_event_id);
create index sap_inventory_snapshots_organization_id_and_resolution_5b997f93 on sap_inventory_snapshots (organization_id, resolution_status, as_of);
create trigger sap_inventory_snapshots_set_updated_at before update on sap_inventory_snapshots for each row execute function set_updated_at();

-- integrationEvents
create table integration_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  event_type text not null,
  status text not null check (status in ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts integer not null,
  payload jsonb not null,
  received_at timestamptz not null,
  processed_at timestamptz,
  last_error text,
  organization_id text,
  schema_version integer,
  payload_hash text,
  correlation_id text,
  causation_id text,
  source_document_id text,
  movement_id uuid,
  next_attempt_at timestamptz,
  acknowledged_at timestamptz,
  external_document_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index integration_events_event_id_key on integration_events (event_id);
create index integration_events_direction_status_idx on integration_events (direction, status);
create index integration_events_status_idx on integration_events (status);
create trigger integration_events_set_updated_at before update on integration_events for each row execute function set_updated_at();

-- connectorHeartbeats
create table connector_heartbeats (
  id uuid primary key default gen_random_uuid(),
  connector_id text not null,
  status text not null check (status in ('online', 'degraded', 'offline')),
  adapter text not null,
  last_seen_at timestamptz not null,
  details text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index connector_heartbeats_connector_key on connector_heartbeats (connector_id);
create trigger connector_heartbeats_set_updated_at before update on connector_heartbeats for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table sap_inventory_snapshots add constraint sap_inventory_snapshots_product_id_fkey foreign key (product_id) references products(id);
alter table sap_inventory_snapshots add constraint sap_inventory_snapshots_location_id_fkey foreign key (location_id) references inventory_locations(id);
alter table integration_events add constraint integration_events_movement_id_fkey foreign key (movement_id) references inventory_movements(id);

-- Supporting indexes for foreign keys without a leading index.
create index sap_inventory_snapshots_product_id_fk_idx on sap_inventory_snapshots (product_id);
create index sap_inventory_snapshots_location_id_fk_idx on sap_inventory_snapshots (location_id);
create index integration_events_movement_id_fk_idx on integration_events (movement_id);
