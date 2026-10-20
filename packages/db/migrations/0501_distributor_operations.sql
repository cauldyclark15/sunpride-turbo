-- F-401/F-409/F-414: private evidence and versioned publications share one scoped store.
create table distributor_documents (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  kind text not null check(kind in ('registration','tax','credit','agreement','claim','deposit','circular','price_notice','scheme_notice','statement')),
  title text not null, version integer not null check(version > 0),
  content bytea not null, mime text not null, sha256 text not null,
  uploaded_by uuid not null references profiles(id), published boolean not null default false,
  supersedes_id uuid references distributor_documents(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table distributor_document_reads (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references distributor_documents(id),
  profile_id uuid not null references profiles(id), sha256 text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(document_id,profile_id)
);
create table distributor_applications (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null unique references distributors(id),
  legal_name text not null, tax_reference text not null, contact text not null,
  submitted_by uuid not null references profiles(id),
  stage text not null check(stage in ('submitted','validated','credit_assessed','agreement','code_requested','accredited','rejected')),
  agreement_document_id uuid references distributor_documents(id), agreement_hash text,
  reviewed_by uuid references profiles(id), credit_assessment jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- SAP owns execution/acknowledgement; requests stay pending unless the SAP seam accepts them.
create table distributor_sap_requests (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  kind text not null, request_key text not null, payload jsonb not null,
  status text not null default 'pending' check(status in ('pending','acknowledged','rejected')),
  acknowledgement jsonb, source text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,request_key)
);
-- F-405: each declaration is a COMPLETE partner snapshot, including zero lines; revisions are immutable.
create table distributor_stock_declarations (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  stock_date date not null, revision integer not null check(revision > 0),
  request_key text not null, payload_hash text not null, source text not null,
  submitted_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(distributor_id,stock_date,revision), unique(distributor_id,request_key)
);
create table distributor_stock_lines (
  id uuid primary key default gen_random_uuid(), declaration_id uuid not null references distributor_stock_declarations(id),
  product_id uuid not null references products(id), location_id uuid not null references distributor_locations(id),
  batch text not null, expiry date, uom text not null, quantity_base bigint not null check(quantity_base >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(declaration_id,product_id,location_id,batch)
);
-- F-406/F-412: source rows stay intact while mapping/rejection can be corrected and replayed.
create table distributor_code_maps (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  kind text not null check(kind in ('product','outlet','location')), external_code text not null,
  entity_id uuid not null, effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  exclude using gist(distributor_id with =, kind with =, external_code with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create table distributor_ingest_runs (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  source_key text not null, payload_hash text not null, adapter text not null, submitted_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,source_key)
);
create table distributor_staging_lines (
  id uuid primary key default gen_random_uuid(), run_id uuid not null references distributor_ingest_runs(id),
  ordinal integer not null, raw jsonb not null,
  status text not null default 'staged' check(status in ('staged','mapping','rejected','posted','duplicate')),
  reason text, fact_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(run_id,ordinal)
);
create table distributor_secondary_lines (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  invoice_number text not null, line_key text not null, revision integer not null check(revision > 0),
  source_key text not null, payload_hash text not null, sale_date date not null,
  kind text not null check(kind in ('sale','return')),
  original_invoice_number text, outlet_id uuid not null references outlets(id), product_id uuid not null references products(id),
  location_id uuid not null references distributor_locations(id), batch text not null,
  uom text not null, quantity_base bigint not null check(quantity_base > 0), amount_centavos bigint not null check(amount_centavos >= 0),
  supersedes_id uuid references distributor_secondary_lines(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(distributor_id,invoice_number,line_key,revision)
);
create index distributor_secondary_period on distributor_secondary_lines(distributor_id,sale_date,product_id);
create view distributor_secondary_current as select f.* from distributor_secondary_lines f where not exists(select 1 from distributor_secondary_lines n where n.supersedes_id=f.id);
-- F-415: replicas, never a local AR ledger. Clearing waits for a subsequent SAP replica.
create table distributor_ar_items (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  source_key text not null, version bigint not null, invoice_number text not null, due_date date not null,
  balance_centavos bigint not null check(balance_centavos >= 0), source text not null check(source in ('sample','sap')),
  received_at timestamptz not null, effective_from timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,source_key)
);
create table distributor_remittances (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  deposit_reference text not null, deposit_date date not null, amount_centavos bigint not null check(amount_centavos > 0),
  evidence_id uuid not null references distributor_documents(id), status text not null default 'submitted' check(status in ('submitted','matched','disputed','sap_pending','acknowledged')),
  allocations jsonb not null default '[]', dispute text, sap_request_id uuid references distributor_sap_requests(id), submitted_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,deposit_reference)
);
-- F-416: primary movements are SAP replicas, not inferred from unfulfilled orders.
create table distributor_primary_movements (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  source_key text not null, version bigint not null, movement_date date not null,
  product_id uuid not null references products(id), quantity_base bigint not null,
  kind text not null check(kind in ('shipment','return','transfer','adjustment')),
  source text not null check(source in ('sample','sap')), received_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,source_key)
);
create table distributor_reconciliation_reviews (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  period_from date not null, period_to date not null, product_id uuid not null references products(id),
  content_hash text not null, explanation text not null, assigned_to uuid not null references profiles(id),
  status text not null check(status in ('explained','accepted','disputed')), reviewed_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- F-409: shared intake seam for TPM (F-505 extends this object).
create table distributor_claims (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  claim_number text not null, kind text not null, period_from date not null, period_to date not null,
  amount_centavos bigint not null check(amount_centavos > 0), reason text not null,
  source_order_id uuid references orders(id), campaign_reference text,
  status text not null default 'submitted', settlement_reference text, settled_centavos bigint,
  submitted_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,claim_number)
);
create table distributor_claim_evidence (
  id uuid primary key default gen_random_uuid(), claim_id uuid not null references distributor_claims(id), document_id uuid not null references distributor_documents(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(claim_id,document_id)
);
create table distributor_capability_audits (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  audit_date date not null, infrastructure_score integer not null check(infrastructure_score between 0 and 100),
  manpower_score integer not null check(manpower_score between 0 and 100), findings text not null,
  audited_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
