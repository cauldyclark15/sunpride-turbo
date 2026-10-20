-- F-306 / F-307 / F-309 / F-611: additive modern-trade workflow extensions.
-- F-305 hierarchy belongs to MASTERS. These are adapter bindings, not another account master.
create table mt_account_bindings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  outlet_id uuid not null references outlets(id),
  account_key text not null,
  banner_key text not null,
  branch_key text not null,
  label text not null,
  source text not null check(source in ('sample','sap')),
  source_version text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to > effective_from),
  exclude using gist(branch_key with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create index mt_bindings_customer on mt_account_bindings(customer_id,effective_from);
create table mt_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id), request_key text not null, payload_hash text not null, response jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(user_id,request_key)
);
create table mt_intake_profiles (
  id uuid primary key default gen_random_uuid(), account_key text not null,
  format text not null check(format in ('csv','edi','email','ocr')),
  columns jsonb not null default '{}', effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to > effective_from),
  exclude using gist(account_key with =,format with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create table mt_po_documents (
  id uuid primary key default gen_random_uuid(), binding_id uuid not null references mt_account_bindings(id),
  filename text not null, format text not null check(format in ('csv','edi','email','ocr')),
  sha256 text not null, content_base64 text not null, received_at timestamptz not null default now(),
  created_by uuid not null references users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(binding_id,sha256)
);
create table inbound_purchase_orders (
  id uuid primary key default gen_random_uuid(), document_id uuid not null unique references mt_po_documents(id),
  binding_id uuid not null references mt_account_bindings(id), po_number text, service_date date,
  status text not null default 'review' check(status in ('review','confirmed')),
  revision integer not null default 1, exceptions jsonb not null default '[]',
  order_id uuid unique references orders(id), confirmed_at timestamptz, created_by uuid not null references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index mt_po_confirmed_number on inbound_purchase_orders(binding_id,lower(po_number)) where status='confirmed';
create table mt_po_lines (
  id uuid primary key default gen_random_uuid(), intake_id uuid not null references inbound_purchase_orders(id), ordinal integer not null,
  product_code text not null, uom text not null, quantity numeric(14,3) not null, requested_price_centavos bigint,
  product_id uuid references products(id), exceptions jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(intake_id,ordinal)
);
create table mt_trade_terms (
  id uuid primary key default gen_random_uuid(), scope_kind text not null check(scope_kind in ('account','banner','branch')),
  scope_key text not null, name text not null, status text not null default 'draft' check(status in ('draft','submitted','approved','rejected')),
  source text not null check(source in ('sample','sap')), sap_key text not null, source_version text not null,
  received_at timestamptz not null default now(), effective_from timestamptz not null, effective_to timestamptz,
  contract_document_id uuid references mt_po_documents(id), requested_by uuid not null references users(id), approved_by uuid references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to > effective_from), check(approved_by is null or approved_by<>requested_by),
  exclude using gist(scope_kind with =,scope_key with =,tstzrange(effective_from,effective_to,'[)') with &&) where(status='approved')
);
create table mt_term_conditions (
  id uuid primary key default gen_random_uuid(), term_id uuid not null references mt_trade_terms(id), ordinal integer not null,
  kind text not null check(kind in ('price','listing_fee','rebate','logistics_allowance')),
  product_id uuid references products(id), uom text, amount_centavos bigint, rate_bps integer,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(term_id,ordinal),
  check(amount_centavos is null or amount_centavos>=0), check(rate_bps is null or rate_bps between 0 and 10000),
  check((amount_centavos is null)<>(rate_bps is null)),
  check(kind<>'price' or (product_id is not null and uom is not null and amount_centavos is not null))
);
create table mt_term_events (
  id uuid primary key default gen_random_uuid(), term_id uuid not null references mt_trade_terms(id),
  actor_user_id uuid not null references users(id), action text not null, note text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table mt_deduction_types (
  id uuid primary key default gen_random_uuid(), code text not null, label text not null, sla_days integer not null check(sla_days between 1 and 365),
  effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(code with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
-- Read replica only: no settlement, credit-memo or SAP accounting writer here.
create table mt_invoice_replicas (
  id uuid primary key default gen_random_uuid(), binding_id uuid not null references mt_account_bindings(id), order_id uuid references orders(id),
  invoice_number text not null, amount_centavos bigint not null check(amount_centavos>=0), issued_on date not null, due_on date not null,
  source text not null check(source in ('sample','sap')), sap_key text not null, source_version text not null, received_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(sap_key,source_version)
);
create table mt_remittances (
  id uuid primary key default gen_random_uuid(), binding_id uuid not null references mt_account_bindings(id), reference text not null,
  received_on date not null, gross_centavos bigint not null check(gross_centavos>=0), paid_centavos bigint not null check(paid_centavos>=0),
  created_by uuid not null references users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(binding_id,reference)
);
create table mt_deductions (
  id uuid primary key default gen_random_uuid(), remittance_id uuid not null references mt_remittances(id), binding_id uuid not null references mt_account_bindings(id),
  invoice_id uuid references mt_invoice_replicas(id), type_id uuid not null references mt_deduction_types(id),
  amount_centavos bigint not null check(amount_centavos>0), claim_reference text, owner_profile_id uuid not null references profiles(id),
  due_on date not null, status text not null default 'open' check(status in ('open','disputed','resolved')),
  resolution text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index mt_deductions_queue on mt_deductions(binding_id,status,due_on);
create table mt_disputes (
  id uuid primary key default gen_random_uuid(), deduction_id uuid not null references mt_deductions(id), submitted_by uuid not null references users(id),
  reference text not null, message text not null, status text not null default 'open' check(status in ('open','accepted','rejected')),
  response text, responded_by uuid references users(id), responded_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index mt_one_open_dispute on mt_disputes(deduction_id) where status='open';
create table mt_deduction_events (
  id uuid primary key default gen_random_uuid(), deduction_id uuid not null references mt_deductions(id), actor_user_id uuid not null references users(id),
  action text not null, note text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- External customer user type deliberately has NO employee profile or employee capabilities.
create table mt_portal_memberships (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id), user_type text not null default 'external_customer' check(user_type='external_customer'),
  name text not null, scope_kind text not null check(scope_kind in ('account','banner','branch')), scope_key text not null,
  effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(user_id with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
-- Original source bytes and approval/event history are immutable.
create function mt_immutable() returns trigger language plpgsql as $$ begin raise exception 'Modern trade evidence is immutable'; end $$;
create trigger mt_documents_immutable before update or delete on mt_po_documents for each row execute function mt_immutable();
create trigger mt_terms_history_immutable before update or delete on mt_term_events for each row execute function mt_immutable();
create trigger mt_deduction_history_immutable before update or delete on mt_deduction_events for each row execute function mt_immutable();
