-- F-506: optional source-line quantities and independently governed execution exceptions.
alter table claims add column product_id uuid references products(id);
alter table claims add column uom text;
alter table claims add column quantity_units bigint;
alter table claims add column last_material_by text;
alter table claims add constraint claim_source_quantity check (
 (product_id is null and uom is null and quantity_units is null) or
 (product_id is not null and uom is not null and quantity_units is not null and quantity_units>0)
);
alter table claim_types add column allow_execution_override boolean not null default false;
create table claim_execution_overrides (
 id uuid primary key default gen_random_uuid(),
 seq bigint generated always as identity,
 claim_id uuid not null references claims(id),
 base_hash text not null,
 waived_reasons jsonb not null,
 reason text not null,
 evidence_reference text not null,
 approved_by text not null,
 approval_rule_id uuid not null references claim_approval_rules(id),
 created_at timestamptz not null default now()
);
create index claim_execution_override_source on claim_execution_overrides(claim_id,base_hash,created_at desc);
create trigger claim_execution_override_immutable before update or delete on claim_execution_overrides for each row execute function tpm_immutable();
-- Refreshes append a new authorized version; original proof links and fingerprints stay immutable.
create table claim_evidence_revisions (
 id uuid primary key default gen_random_uuid(),
 seq bigint generated always as identity,
 evidence_id uuid not null references claim_evidence(id),
 fingerprint text not null,
 snapshot jsonb not null,
 reason text not null,
 actor_subject text not null,
 created_at timestamptz not null default now()
);
create index claim_evidence_revision_latest on claim_evidence_revisions(evidence_id,created_at desc);
create trigger claim_evidence_revision_immutable before update or delete on claim_evidence_revisions for each row execute function tpm_immutable();
