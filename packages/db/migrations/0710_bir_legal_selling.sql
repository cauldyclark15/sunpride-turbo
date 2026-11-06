-- IP-BIR: legal selling. Privilege discount claims, BIR receipt identifiers, buyer billing profile,
-- typed per-document tax rows, append-only e-journal. Additive only.

-- 1. BIR identifiers on the registration (PTU / MIN / machine serial / accreditation / POS provider).
alter table fiscal_registrations
  add column ptu_number text,
  add column ptu_issued_on date,
  add column min_number text,
  add column machine_serial text,
  add column accreditation_number text,
  add column accreditation_date date,
  add column pos_provider jsonb not null default '{}';

-- 2. Buyer billing profile: name, TIN and address printed on the invoice. Editable at the sale.
create table outlet_billing_profiles (
  outlet_id uuid primary key references outlets(id),
  registered_name text,
  tin text,
  address text,
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger fiscal_capture after insert or update or delete on outlet_billing_profiles
  for each row execute function fiscal_capture_change();

-- 3. Where SC / PWD / solo parent / athlete / uniformed discounts are accepted.
-- No row = default: ON for store tills, OFF for vans (SPEC 6.2). route_id null = whole branch.
create table privilege_discount_settings (
  id uuid primary key default gen_random_uuid(),
  org_unit_id uuid not null references org_units(id),
  surface text not null check (surface in ('store','van')),
  route_id uuid references routes(id),
  enabled boolean not null,
  effective_from timestamptz not null default now(),
  set_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index privilege_settings_lookup on privilege_discount_settings(org_unit_id, surface, effective_from desc);
create trigger fiscal_capture after insert or update or delete on privilege_discount_settings
  for each row execute function fiscal_capture_change();

-- 4. One discount claim per sale. Append-only evidence of who was given which statutory discount.
create table sale_discount_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  source_type text not null check (source_type in ('store_sale','van_sale')),
  source_id uuid not null,
  org_unit_id uuid references org_units(id),
  privilege_type text not null check (privilege_type in ('senior','pwd','solo_parent','athlete','uniformed')),
  id_number text not null,
  holder_name text not null,
  eligible_product_ids jsonb,
  applied boolean not null,
  gross_centavos bigint not null check (gross_centavos >= 0),
  promo_discount_centavos bigint not null default 0,
  privilege_discount_centavos bigint not null default 0,
  vat_removed_centavos bigint not null default 0,
  total_centavos bigint not null check (total_centavos >= 0),
  claimed jsonb not null,
  computed jsonb not null,
  fiscal_document_id uuid references fiscal_documents(id),
  recorded_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (source_type, source_id)
);
create index sale_discount_claims_type_day on sale_discount_claims(privilege_type, created_at);
create index sale_discount_claims_holder on sale_discount_claims(privilege_type, id_number);
create trigger sale_discount_claims_immutable before update or delete on sale_discount_claims
  for each row execute function fiscal_immutable();

-- 5. Typed per-document tax row (the Z reading and tax summary read this, never the JSON blob).
-- Buckets are shown BEFORE the privilege discount: vatable+vat+vat_exempt+zero_rated = total_due + privilege_discount.
create table fiscal_document_tax (
  document_id uuid primary key references fiscal_documents(id),
  org_unit_id uuid not null references org_units(id),
  source_type text not null,
  document_type text not null,
  issued_at timestamptz not null,
  business_date date not null,
  gross_centavos bigint not null,
  vatable_centavos bigint not null,
  vat_centavos bigint not null,
  vat_exempt_centavos bigint not null,
  zero_rated_centavos bigint not null,
  promo_discount_centavos bigint not null default 0,
  privilege_discount_centavos bigint not null default 0,
  vat_removed_centavos bigint not null default 0,
  privilege_type text,
  total_due_centavos bigint not null,
  created_at timestamptz not null default now()
);
create index fiscal_document_tax_day on fiscal_document_tax(org_unit_id, business_date);
create trigger fiscal_document_tax_immutable before update or delete on fiscal_document_tax
  for each row execute function fiscal_immutable();

-- Backfill documents already issued (no privilege existed before this migration).
insert into fiscal_document_tax(document_id, org_unit_id, source_type, document_type, issued_at, business_date,
  gross_centavos, vatable_centavos, vat_centavos, vat_exempt_centavos, zero_rated_centavos, total_due_centavos)
select d.id, r.org_unit_id, d.source_type, r.document_type, d.issued_at,
  (d.issued_at at time zone 'Asia/Manila')::date,
  (d.snapshot->'tax'->>'totalMinor')::bigint,
  (d.snapshot->'tax'->>'vatableSalesMinor')::bigint,
  (d.snapshot->'tax'->>'vatMinor')::bigint,
  (d.snapshot->'tax'->>'vatExemptMinor')::bigint,
  (d.snapshot->'tax'->>'zeroRatedMinor')::bigint,
  (d.snapshot->'tax'->>'totalMinor')::bigint
from fiscal_documents d
join fiscal_series s on s.id = d.series_id
join fiscal_registrations r on r.id = s.registration_id
where d.source_type in ('van_sale','store_sale')
  and d.snapshot->'tax'->>'totalMinor' ~ '^[0-9]{1,15}$'
  and d.snapshot->'tax'->>'vatableSalesMinor' ~ '^[0-9]{1,15}$'
  and d.snapshot->'tax'->>'vatMinor' ~ '^[0-9]{1,15}$'
  and d.snapshot->'tax'->>'vatExemptMinor' ~ '^[0-9]{1,15}$'
  and d.snapshot->'tax'->>'zeroRatedMinor' ~ '^[0-9]{1,15}$';

-- 6. E-journal: one append-only, hash-chained row per printed / reprinted / voided / spoiled document.
-- Written by a trigger on fiscal_document_events so no code path (van, store, office) can skip it.
-- The print-model hash is passed by the writer through the transaction setting sunpride.ejournal_model_hash;
-- when absent (e.g. a void raised by another module) the document snapshot hash is used and hash_basis says so.
create table fiscal_ejournal (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  org_unit_id uuid not null references org_units(id),
  document_id uuid not null references fiscal_documents(id),
  document_event_id uuid not null unique references fiscal_document_events(id),
  document_number text not null,
  document_type text not null,
  entry_kind text not null check (entry_kind in ('printed','reprinted','voided','spoiled')),
  copy_number integer not null default 0,
  reason text,
  actor_profile_id uuid references profiles(id),
  print_outcome text,
  model_hash text not null,
  hash_basis text not null check (hash_basis in ('print_model','document_snapshot')),
  prev_hash text,
  entry_hash text not null,
  occurred_at timestamptz not null
);
create index fiscal_ejournal_doc on fiscal_ejournal(document_id, seq);
create index fiscal_ejournal_unit on fiscal_ejournal(org_unit_id, seq);
create trigger fiscal_ejournal_immutable before update or delete on fiscal_ejournal
  for each row execute function fiscal_immutable();

create function fiscal_ejournal_hash(prev text, doc_number text, kind text, copy_no integer, model_hash text, event_id uuid, at timestamptz)
returns text language sql immutable as $$
  select encode(sha256(convert_to(
    coalesce(prev,'') || '|' || doc_number || '|' || kind || '|' || copy_no::text || '|' || model_hash || '|' || event_id::text || '|' ||
    to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'utf8')), 'hex');
$$;

create function fiscal_ejournal_append() returns trigger language plpgsql as $$
declare
  d record; k text; copies integer; mh text; basis text; prev text; unit uuid; eh text;
begin
  k := case new.kind when 'print' then 'printed' when 'reprint' then 'reprinted' when 'void' then 'voided' when 'spoiled' then 'spoiled' else null end;
  if k is null then return new; end if;
  select doc.id, doc.document_number, doc.snapshot_hash, r.document_type, r.org_unit_id into d
    from fiscal_documents doc join fiscal_series s on s.id = doc.series_id join fiscal_registrations r on r.id = s.registration_id
    where doc.id = new.document_id;
  unit := d.org_unit_id;
  select count(*) into copies from fiscal_document_events e
    where e.document_id = new.document_id and e.kind = new.kind and (e.created_at, e.id) <= (new.created_at, new.id);
  mh := nullif(current_setting('sunpride.ejournal_model_hash', true), '');
  basis := 'print_model';
  if mh is null then mh := d.snapshot_hash; basis := 'document_snapshot'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fiscal_ejournal:' || unit::text, 0));
  select entry_hash into prev from fiscal_ejournal where org_unit_id = unit order by seq desc limit 1;
  eh := fiscal_ejournal_hash(prev, d.document_number, k, case when k in ('printed','reprinted') then copies else 0 end, mh, new.id, new.created_at);
  insert into fiscal_ejournal(org_unit_id, document_id, document_event_id, document_number, document_type, entry_kind, copy_number,
    reason, actor_profile_id, print_outcome, model_hash, hash_basis, prev_hash, entry_hash, occurred_at)
  values(unit, d.id, new.id, d.document_number, d.document_type, k, case when k in ('printed','reprinted') then copies else 0 end,
    new.reason, new.actor_profile_id, new.facts->>'outcome', mh, basis, prev, eh, new.created_at);
  return new;
end; $$;
create trigger fiscal_ejournal_append after insert on fiscal_document_events
  for each row execute function fiscal_ejournal_append();

-- Chain check: returns the sequence numbers whose hash does not match their content or predecessor.
create function fiscal_ejournal_broken(unit uuid) returns setof bigint language sql stable as $$
  select e.seq from (
    select j.*, lag(j.entry_hash) over (order by j.seq) as expected_prev from fiscal_ejournal j where j.org_unit_id = unit
  ) e
  where e.prev_hash is distinct from e.expected_prev
     or e.entry_hash <> fiscal_ejournal_hash(e.prev_hash, e.document_number, e.entry_kind, e.copy_number, e.model_hash, e.document_event_id, e.occurred_at)
  order by e.seq;
$$;
