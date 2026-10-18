-- 0111_call_sheets: Call sheets.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: call_sheet_accounts, call_sheet_account_lines, call_sheet_account_revisions, call_sheet_account_revision_products, call_sheet_entries.

-- callSheetAccounts [synced]
create table call_sheet_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  outlet_id uuid not null,
  revision integer not null,
  header_account_name text not null,
  header_address text,
  header_buyer_name text,
  header_contact_number text,
  header_account_in_charge text,
  header_receiving_in_charge text,
  header_distributor_name text,
  header_distributor_schedule text,
  header_foc text,
  header_pricing text,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index call_sheet_accounts_outlet_id_key on call_sheet_accounts (outlet_id);
create index call_sheet_accounts_organization_id_and_updated_at_idx on call_sheet_accounts (organization_id, updated_at);
create index call_sheet_accounts_change_seq_idx on call_sheet_accounts (change_seq);
create trigger call_sheet_accounts_bump_change_seq before update on call_sheet_accounts for each row execute function bump_change_seq();

-- callSheetAccounts (callSheetAccounts.lines[]) [synced]
create table call_sheet_account_lines (
  id uuid primary key default gen_random_uuid(),
  call_sheet_account_id uuid not null,
  ordinal integer not null,
  product_id uuid not null,
  pricing text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index call_sheet_account_lines_parent_ordinal_key on call_sheet_account_lines (call_sheet_account_id, ordinal);
create index call_sheet_account_lines_change_seq_idx on call_sheet_account_lines (change_seq);
create trigger call_sheet_account_lines_bump_change_seq before update on call_sheet_account_lines for each row execute function bump_change_seq();

-- callSheetAccountRevisions [synced]
create table call_sheet_account_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  outlet_id uuid not null,
  revision integer not null,
  effective_from timestamptz not null,
  superseded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index call_sheet_account_revisions_outlet_id_and_superseded_at_idx on call_sheet_account_revisions (outlet_id, superseded_at);
create index call_sheet_account_revisions_change_seq_idx on call_sheet_account_revisions (change_seq);
create trigger call_sheet_account_revisions_bump_change_seq before update on call_sheet_account_revisions for each row execute function bump_change_seq();

-- callSheetAccountRevisions (callSheetAccountRevisions.productIds[]) [synced]
create table call_sheet_account_revision_products (
  id uuid primary key default gen_random_uuid(),
  call_sheet_account_revision_id uuid not null,
  ordinal integer not null,
  product_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index call_sheet_account_revision_products_parent_ordinal_key on call_sheet_account_revision_products (call_sheet_account_revision_id, ordinal);
create index call_sheet_account_revision_products_change_seq_idx on call_sheet_account_revision_products (change_seq);
create trigger call_sheet_account_revision_products_bump_change_seq before update on call_sheet_account_revision_products for each row execute function bump_change_seq();

-- callSheetEntries [synced]
create table call_sheet_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  org_unit_id uuid not null,
  outlet_id uuid not null,
  visit_id uuid not null,
  activity_id uuid not null,
  assignee_profile_id uuid not null,
  service_date date not null,
  local_month text not null check (local_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  week integer not null,
  product_id uuid not null,
  template_revision integer not null,
  order_qty integer,
  beginning_inventory integer,
  take integer,
  delivered integer,
  offtake integer,
  end_inventory integer,
  server_time timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index call_sheet_entries_outlet_id_and_local_month_and_week_idx on call_sheet_entries (outlet_id, local_month, week);
create index call_sheet_entries_change_seq_idx on call_sheet_entries (change_seq);
create trigger call_sheet_entries_bump_change_seq before update on call_sheet_entries for each row execute function bump_change_seq();

-- Foreign keys (added after every table in this file exists).
alter table call_sheet_accounts add constraint call_sheet_accounts_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table call_sheet_account_lines add constraint call_sheet_account_lines_call_sheet_account_id_fkey foreign key (call_sheet_account_id) references call_sheet_accounts(id) on delete cascade;
alter table call_sheet_account_lines add constraint call_sheet_account_lines_product_id_fkey foreign key (product_id) references products(id);
alter table call_sheet_account_revisions add constraint call_sheet_account_revisions_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table call_sheet_account_revision_products add constraint call_sheet_account_revision_products_call_sheet_accoun_4fc8be7a foreign key (call_sheet_account_revision_id) references call_sheet_account_revisions(id) on delete cascade;
alter table call_sheet_account_revision_products add constraint call_sheet_account_revision_products_product_id_fkey foreign key (product_id) references products(id);
alter table call_sheet_entries add constraint call_sheet_entries_org_unit_id_fkey foreign key (org_unit_id) references org_units(id);
alter table call_sheet_entries add constraint call_sheet_entries_outlet_id_fkey foreign key (outlet_id) references outlets(id);
alter table call_sheet_entries add constraint call_sheet_entries_visit_id_fkey foreign key (visit_id) references visit_executions(id);
alter table call_sheet_entries add constraint call_sheet_entries_activity_id_fkey foreign key (activity_id) references visit_activities(id);
alter table call_sheet_entries add constraint call_sheet_entries_assignee_profile_id_fkey foreign key (assignee_profile_id) references profiles(id);
alter table call_sheet_entries add constraint call_sheet_entries_product_id_fkey foreign key (product_id) references products(id);

-- Supporting indexes for foreign keys without a leading index.
create index call_sheet_account_lines_product_id_fk_idx on call_sheet_account_lines (product_id);
create index call_sheet_account_revision_products_product_id_fk_idx on call_sheet_account_revision_products (product_id);
create index call_sheet_entries_org_unit_id_fk_idx on call_sheet_entries (org_unit_id);
create index call_sheet_entries_visit_id_fk_idx on call_sheet_entries (visit_id);
create index call_sheet_entries_activity_id_fk_idx on call_sheet_entries (activity_id);
create index call_sheet_entries_assignee_profile_id_fk_idx on call_sheet_entries (assignee_profile_id);
create index call_sheet_entries_product_id_fk_idx on call_sheet_entries (product_id);
