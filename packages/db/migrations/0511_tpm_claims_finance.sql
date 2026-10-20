-- F-504 operational instructions only: SAP, never these tables, is the financial ledger.
create table promotion_earnings (
 id uuid primary key default gen_random_uuid(),
 campaign_version_id uuid not null references campaign_versions(id),
 promotion_id uuid not null references promotions(id),
 source_key text not null unique,
 source_hash text not null,
 outlet_id uuid references outlets(id),
 account_key text not null,
 earned_at timestamptz not null,
 amount_centavos bigint not null check(amount_centavos > 0),
 reversed_centavos bigint not null default 0 check(reversed_centavos >= 0 and reversed_centavos <= amount_centavos),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table claim_types (
 id uuid primary key default gen_random_uuid(), code text not null,
 effective_from timestamptz not null, effective_to timestamptz not null,
 required_evidence jsonb not null, source text not null check(source in ('sample','office')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(effective_to > effective_from),
 exclude using gist(code with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
-- F-505: owned here for F-409/F-309 adapters, not one claims table per channel.
create table claims (
 id uuid primary key default gen_random_uuid(), reference text not null unique,
 claimant_party_type text not null check(claimant_party_type in ('distributor','modern_trade','agency')),
 claimant_party_id text not null, claimant_name text not null,
 type_id uuid not null references claim_types(id),
 campaign_version_id uuid references campaign_versions(id),
 earning_id uuid references promotion_earnings(id),
 outlet_id uuid references outlets(id),
 period_from date not null, period_to date not null,
 amount_centavos bigint not null check(amount_centavos > 0), currency text not null default 'PHP' check(currency='PHP'),
 status text not null default 'submitted' check(status in ('submitted','needs_evidence','validated','approved','rejected','part_settled','settled')),
 created_by text not null, validated_by text, approved_by text,
 validation_hash text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(period_to >= period_from)
);
create table claim_evidence (
 id uuid primary key default gen_random_uuid(), claim_id uuid not null references claims(id),
 kind text not null, source_id uuid not null, fingerprint text not null,
 snapshot jsonb not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(claim_id,kind,source_id), unique(fingerprint)
);
create table claim_events (
 id uuid primary key default gen_random_uuid(), claim_id uuid not null references claims(id),
 action text not null, actor_subject text not null, details jsonb not null default '{}',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table claim_validation_runs (
 id uuid primary key default gen_random_uuid(), claim_id uuid not null references claims(id),
 passed boolean not null, results jsonb not null, content_hash text not null, actor_subject text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table claim_approval_rules (
 id uuid primary key default gen_random_uuid(), name text not null,
 party_type text not null check(party_type in ('distributor','modern_trade','agency','all')),
 min_centavos bigint not null check(min_centavos>=0), max_centavos bigint not null check(max_centavos>=min_centavos),
 approver_roles jsonb not null,
 effective_from timestamptz not null, effective_to timestamptz not null,
 source text not null check(source in ('sample','office')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(effective_to > effective_from)
);
create table claim_settlements (
 id uuid primary key default gen_random_uuid(), claim_id uuid not null references claims(id),
 amount_centavos bigint not null check(amount_centavos > 0),
 method text not null check(method in ('credit_memo','payment')),
 status text not null default 'pending' check(status in ('pending','acknowledged','rejected')),
 created_by text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table tpm_posting_instructions (
 id uuid primary key default gen_random_uuid(), source_key text not null unique,
 kind text not null check(kind in ('accrual','reversal','credit_memo','payment','release')),
 earning_id uuid references promotion_earnings(id), settlement_id uuid references claim_settlements(id),
 amount_centavos bigint not null check(amount_centavos > 0), payload jsonb not null,
 status text not null default 'awaiting_seam' check(status in ('awaiting_seam','queued','acknowledged','rejected')),
 sap_document text, sap_response_hash text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table claim_notifications (
 id uuid primary key default gen_random_uuid(), claim_id uuid not null references claims(id),
 party_type text not null, party_id text not null, message text not null,
 read_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table deductions (
 id uuid primary key default gen_random_uuid(), source_key text not null unique,
 account_key text not null, classification text not null,
 invoice_reference text not null, remittance_reference text not null,
 claim_id uuid references claims(id), amount_centavos bigint not null check(amount_centavos > 0),
 recovered_centavos bigint not null default 0 check(recovered_centavos>=0 and recovered_centavos<=amount_centavos),
 owner_profile_id uuid not null references profiles(id),
 status text not null default 'open' check(status in ('open','disputed','resolved')),
 opened_on date not null, due_on date not null check(due_on>=opened_on),
 created_by text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table deduction_events (
 id uuid primary key default gen_random_uuid(), deduction_id uuid not null references deductions(id),
 action text not null, actor_subject text not null, reason text not null, recovered_centavos bigint not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index claims_queue on claims(status,created_at);
create index claims_party on claims(claimant_party_type,claimant_party_id,period_from);
create index promotion_earnings_campaign on promotion_earnings(campaign_version_id,earned_at);
-- F-506 evidence, validation and event history are append-only.
create function tpm_immutable() returns trigger language plpgsql as $$ begin
 if TG_OP='DELETE' and current_setting('sunpride.seed_reset',true)='sunpride-demo-v2'
   and exists(select 1 from sample_data_rows where batch='sunpride-demo-v2' and table_name=TG_TABLE_NAME and row_id=old.id::text)
 then return old; end if;
 raise exception 'TPM evidence and history are append-only';
end $$;
create trigger claim_evidence_immutable before update or delete on claim_evidence for each row execute function tpm_immutable();
create trigger claim_events_immutable before update or delete on claim_events for each row execute function tpm_immutable();
create trigger claim_validation_immutable before update or delete on claim_validation_runs for each row execute function tpm_immutable();
create trigger deduction_events_immutable before update or delete on deduction_events for each row execute function tpm_immutable();
