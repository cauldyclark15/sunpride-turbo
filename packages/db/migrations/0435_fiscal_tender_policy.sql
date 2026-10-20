-- F-111: versioned branch tender policy; security properties remain invariants.
create table fiscal_tender_rules (
 id uuid primary key default gen_random_uuid(), org_unit_id uuid not null references org_units(id),
 method text not null check(method in ('cash','gcash','maya','card','check','bank_transfer','credit')),
 label text not null check(length(label) between 1 and 40), reference_label text,
 enabled boolean not null default true, effective_from timestamptz not null, effective_to timestamptz,
 sample boolean not null default false, entered_by uuid not null references profiles(id),
 created_at timestamptz not null default now(),
 check(effective_to is null or effective_to>effective_from), unique(org_unit_id,method,effective_from)
);
create index fiscal_tender_effective on fiscal_tender_rules(org_unit_id,method,effective_from,effective_to);
create trigger fiscal_tender_rule_capture after insert or update or delete on fiscal_tender_rules for each row execute function fiscal_capture_change();
