-- IP-INT5: a partial refund of a senior / PWD discounted sale gives back its share of the weekly limit.
-- (A void already gives all of it back: the voided invoice's ledger row is not counted.)
-- One row per refund that touched a ledger row; append-only like the ledger. The ledger row itself is never edited.
--   refunded_gross_centavos = the regular price of the discounted part of the sale that this refund took back
--   released_gross_centavos = the part of the limit given back (applied gross x refunded share of the discounted lines)
create table privilege_cap_releases (
  refund_id uuid primary key references sale_refunds(id),
  ledger_id uuid not null references privilege_cap_ledger(id),
  id_hash text not null,
  week_start date not null,
  refunded_gross_centavos bigint not null check (refunded_gross_centavos >= 0),
  released_gross_centavos bigint not null check (released_gross_centavos >= 0),
  created_at timestamptz not null default now()
);
create index privilege_cap_releases_ledger on privilege_cap_releases(ledger_id);
create trigger privilege_cap_releases_immutable before update or delete on privilege_cap_releases
  for each row execute function fiscal_immutable();
