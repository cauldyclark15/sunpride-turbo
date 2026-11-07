-- IP-SCPWD-CAP: weekly purchase cap on the senior citizen / PWD discount, tracked per ID across every store and van.
--
-- Legal basis (see reports/scpwd-cap-report.md): the 5% special discount on basic necessities and prime commodities
-- (JAO 17-02 s.2017, replaced by JAO 24-02 s.2024: PHP 2,500 of purchases / PHP 125 of discount per calendar week).
-- The amount is an office setting; the shipped default is a default, to be confirmed with Sunpride's accountant.
--
-- Both tables are append-only: a change of the limit is a new row (who, when), never an edit.

-- 1. The limit. Newest row whose effective_from has passed wins. No row = the shipped default (cap 250000 centavos, on).
create table privilege_cap_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  enabled boolean not null default true,
  cap_centavos bigint not null check (cap_centavos > 0 and cap_centavos <= 100000000),
  -- false until the office records that Sunpride's accountant confirmed the figure; the screens say so while false
  accountant_confirmed boolean not null default false,
  note text,
  effective_from timestamptz not null default now(),
  set_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);
create index privilege_cap_settings_lookup on privilege_cap_settings(organization_id, effective_from desc, created_at desc);
create trigger privilege_cap_settings_immutable before update or delete on privilege_cap_settings
  for each row execute function fiscal_immutable();

-- 2. What each senior / PWD sale used of the week's limit. One row per sale that carried a senior or PWD claim.
--    id_key is the normalised card number with its type (senior:12345); id_hash is the same thing hashed, which is all a
--    phone ever receives. week_start is the Monday of the Manila week the sale was made in.
--    applied_gross_centavos = the part of the purchase that actually got the discount (counts against the limit).
--    overage_centavos = the part of this sale that went past what the server still had left when the sale reached it
--    (an offline phone could not know). short_centavos = the part the phone left out although the limit still had room.
create table privilege_cap_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  source_type text not null check (source_type in ('store_sale','van_sale')),
  source_id uuid not null,
  org_unit_id uuid references org_units(id),
  privilege_type text not null check (privilege_type in ('senior','pwd')),
  id_key text not null,
  id_hash text not null,
  week_start date not null,
  sold_at timestamptz not null,
  eligible_gross_centavos bigint not null check (eligible_gross_centavos >= 0),
  applied_gross_centavos bigint not null check (applied_gross_centavos >= 0),
  discount_centavos bigint not null check (discount_centavos >= 0),
  cap_centavos bigint,
  used_before_centavos bigint not null check (used_before_centavos >= 0),
  overage_centavos bigint not null default 0 check (overage_centavos >= 0),
  short_centavos bigint not null default 0 check (short_centavos >= 0),
  claim_basis text not null check (claim_basis in ('phone_cap','phone_uncapped','server')),
  fiscal_document_id uuid references fiscal_documents(id),
  created_at timestamptz not null default now(),
  unique (source_type, source_id),
  check (applied_gross_centavos <= eligible_gross_centavos)
);
create index privilege_cap_ledger_week on privilege_cap_ledger(id_key, week_start);
create index privilege_cap_ledger_week_all on privilege_cap_ledger(week_start);
create index privilege_cap_ledger_flags on privilege_cap_ledger(created_at desc) where overage_centavos > 0 or short_centavos > 0;
create trigger privilege_cap_ledger_immutable before update or delete on privilege_cap_ledger
  for each row execute function fiscal_immutable();
