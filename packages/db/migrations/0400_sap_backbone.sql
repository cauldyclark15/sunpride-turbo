-- F-002/F-003/F-005: the existing integration_events table is the durable inbox/outbox.
alter table integration_events
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column heartbeat_at timestamptz,
  add column owner_profile_id uuid references profiles(id),
  add column org_unit_id uuid references org_units(id),
  add column severity text not null default 'medium' check(severity in ('low','medium','high')),
  add column escalated_at timestamptz,
  add column error_class text check(error_class in ('transport','throttle','rejection','conflict','contract','configuration')),
  add column sap_result jsonb,
  add column source_type text,
  add column source_id text;
create index integration_events_due on integration_events(direction,status,next_attempt_at,lease_expires_at);
create table integration_conflicts (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  original_hash text not null,
  incoming_hash text not null,
  payload jsonb not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(event_id,incoming_hash)
);
create table integration_resolution_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references integration_events(id),
  action text not null,
  actor_profile_id uuid,
  facts jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index integration_resolution_trace on integration_resolution_events(event_id,created_at,id);
create function integration_append_only() returns trigger language plpgsql as $$
begin raise exception 'integration trace is append only'; end $$;
create trigger integration_resolution_immutable before update or delete on integration_resolution_events for each row execute function integration_append_only();
create trigger integration_conflict_immutable before update or delete on integration_conflicts for each row execute function integration_append_only();

-- F-015/F-016/F-101: retain every source version; SAP key + validity is the authority.
create table sap_replicas (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  master_id uuid not null,
  kind text not null check(kind in ('material','condition','customer','outlet','ar','location','stock')),
  sap_key text not null,
  sap_version bigint not null check(sap_version>0),
  source text not null check(source in ('sample','sap')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  received_at timestamptz not null default now(),
  payload_hash text not null,
  payload jsonb not null,
  price_list_id uuid references price_lists(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  unique(organization_id,kind,sap_key,sap_version),
  check(effective_to is null or effective_to>effective_from)
);
create index sap_replicas_lookup on sap_replicas(organization_id,kind,sap_key,sap_version desc);
create index sap_replicas_seq on sap_replicas(change_seq);
create trigger sap_replicas_bump before update on sap_replicas for each row execute function bump_change_seq();
create table sap_feed_cursors (
  id uuid primary key default gen_random_uuid(),
  kind text not null unique,
  cursor text,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table products add column sap_key text, add column sap_version bigint, add column sap_received_at timestamptz,
  add column shelf_life_days integer, add column storage_condition text;
alter table inventory_locations add column sap_plant text, add column sap_storage_location text, add column sap_version bigint,
  add column sap_received_at timestamptz;
alter table inventory_balances add column valuation_source text not null default 'operational_estimate',
  add column sap_value_minor bigint, add column sap_value_as_of timestamptz;
alter table inventory_movements add column sap_document_number text;
alter table orders add column sap_credit_decision_id uuid;
alter table van_sales add column sap_document_number text, add column sap_credit_decision_id uuid;
alter table van_payments add column sap_document_number text;
alter table van_returns add column sap_document_number text;
alter table van_trips add column sap_settlement_document_number text;
alter table price_lists drop constraint price_lists_source_check;
alter table price_lists add constraint price_lists_source_check check(source in ('sample','office','sap'));
alter table field_order_pricings drop constraint field_order_pricings_price_list_source_check;
alter table field_order_pricings add constraint field_order_pricings_price_list_source_check check(price_list_source in ('sample','office','sap'));

-- F-112/F-404: expiring SAP-issued decisions, never a locally computed credit ledger.
create table sap_credit_decisions (
  id uuid primary key default gen_random_uuid(),
  customer_code text not null,
  amount_centavos bigint not null,
  request_id text not null unique,
  decision_token text not null unique,
  status text not null check(status in ('within','over','no_limit','unknown')),
  limit_centavos bigint,
  exposure_centavos bigint,
  source text not null,
  checked_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_by text unique,
  override_request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table orders add constraint orders_sap_credit_fk foreign key(sap_credit_decision_id) references sap_credit_decisions(id);
alter table van_sales add constraint van_sales_sap_credit_fk foreign key(sap_credit_decision_id) references sap_credit_decisions(id);
create index sap_credit_customer on sap_credit_decisions(customer_code,checked_at desc);
create table sap_credit_override_requests (
  id uuid primary key default gen_random_uuid(),
  customer_code text not null,
  amount_centavos bigint not null,
  facts_hash text not null,
  requester_profile_id uuid not null references profiles(id),
  org_unit_id uuid references org_units(id),
  reason text not null,
  status text not null default 'pending_sap' check(status in ('pending_sap','submitted','rejected')),
  fiscal_request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
