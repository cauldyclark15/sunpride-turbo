-- Inventory command receipts cover document-only actions as well as stock posting.
-- Separate from the movement command: one receipt returns the original document IDs.
create table inventory_action_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  idempotency_key text not null,
  action text not null,
  payload_hash text not null,
  actor_user_id uuid not null references users(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);
create index inventory_ledger_location_date on inventory_ledger_entries (organization_id, location_id, effective_at);
create index inventory_count_counter on stock_count_sessions (created_by, location_id, status);
create index inventory_lots_due on inventory_lots (expires_at) where quality_status <> 'expired';
