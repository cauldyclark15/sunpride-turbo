-- F-116/F-117: correction evidence is append-only; original counts/receipts/settlements are never overwritten.
create table van_reconciliation_changes(
 id uuid primary key default gen_random_uuid(),trip_id uuid not null references van_trips(id),
 kind text not null check(kind in ('unload_remainder','adjustment_reference','empties_loss','cash_recount')),
 basis_hash text not null,facts jsonb not null,reason text not null,
 requested_by uuid not null references profiles(id),requested_role text not null,created_at timestamptz not null default now()
);
create table van_reconciliation_decisions(
 change_id uuid primary key references van_reconciliation_changes(id),decision text not null check(decision in ('approved','rejected')),
 actor_profile_id uuid not null references profiles(id),reason text not null,
 movement_id uuid references inventory_movements(id),created_at timestamptz not null default now()
);
create unique index van_reconciliation_movement_once on van_reconciliation_decisions(movement_id) where movement_id is not null;
create trigger van_reconciliation_changes_immutable before update or delete on van_reconciliation_changes for each row execute function fiscal_immutable();
create trigger van_reconciliation_decisions_immutable before update or delete on van_reconciliation_decisions for each row execute function fiscal_immutable();
