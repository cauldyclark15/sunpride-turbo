-- Lane FIELDREPORTS: command replay receipts and domain-local append-only audit.
create table field_report_commands (
  actor_id uuid not null references profiles(id),
  command text not null,
  request_key text not null,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, command, request_key)
);
create table field_report_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references profiles(id),
  command text not null,
  entity_id text,
  details jsonb not null,
  created_at timestamptz not null default now()
);
create unique index talk_sheets_one_draft_partner on talk_sheets(org_unit_id, partner_key) where status = 'draft';
create unique index call_sheet_revision_identity on call_sheet_account_revisions(outlet_id, revision);
create unique index call_sheet_entry_activity_product on call_sheet_entries(activity_id, product_id) where deleted_at is null;
create index field_day_reports_unit_date on field_day_reports(org_unit_id, service_date);
