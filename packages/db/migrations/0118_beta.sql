-- 0118_beta: Beta sample-data markers.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: sample_data_rows, sample_data_changes.

-- sampleDataRows
create table sample_data_rows (
  id uuid primary key default gen_random_uuid(),
  batch text not null,
  table_name text not null,
  row_id text not null,
  key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sample_data_rows_batch_and_key_key on sample_data_rows (batch, key);
create index sample_data_rows_batch_idx on sample_data_rows (batch);
create trigger sample_data_rows_set_updated_at before update on sample_data_rows for each row execute function set_updated_at();

-- sampleDataChanges
create table sample_data_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  kind text not null check (kind in ('customer_credit_limit')),
  customer_id uuid not null,
  previous_value integer not null,
  sample_value integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sample_data_changes_organization_id_and_customer_id_key on sample_data_changes (organization_id, customer_id);
create trigger sample_data_changes_set_updated_at before update on sample_data_changes for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table sample_data_changes add constraint sample_data_changes_customer_id_fkey foreign key (customer_id) references customers(id);

-- Supporting indexes for foreign keys without a leading index.
create index sample_data_changes_customer_id_fk_idx on sample_data_changes (customer_id);
