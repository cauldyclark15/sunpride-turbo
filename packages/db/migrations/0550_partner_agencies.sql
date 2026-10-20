-- F-322 SEAM(DISTRIBUTOR): reuse the canonical partner identity tables.
-- Standalone CALLFLOW-based lane only: these two IF NOT EXISTS definitions match
-- 0500. On integration 0500/0506 run first; do not introduce another partner model.
create table if not exists distributors (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null,
  org_unit_id uuid not null references org_units(id),
  status text not null default 'applicant' check(status in ('applicant','review','accredited','suspended','rejected')),
  sap_customer_code text unique, source text not null check(source in ('sample','office','sap')),
  effective_from timestamptz not null default now(), effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to > effective_from)
);
create table if not exists distributor_users (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  profile_id uuid not null references profiles(id), grants text[] not null default '{}',
  effective_from timestamptz not null default now(), effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  exclude using gist(profile_id with =, tstzrange(effective_from,effective_to,'[)') with &&),
  check(effective_to is null or effective_to > effective_from)
);
alter table distributors add column if not exists device_org_unit_id uuid unique references org_units(id);
alter table distributors add column partner_kind text not null default 'distributor' check(partner_kind in ('distributor','agency'));
-- A portal actor has NO employee capabilities. Field staff keep the existing
-- sales execution adapter but an additional partner boundary restricts it.
alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check check(role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer','distributor','agency'));
alter table access_invitations drop constraint access_invitations_role_check;
alter table access_invitations add constraint access_invitations_role_check check(role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer','distributor','agency'));
alter table employee_assignments drop constraint employee_assignments_role_check;
alter table employee_assignments add constraint employee_assignments_role_check check(role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer','distributor','agency'));

create table partner_outlet_assignments (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  outlet_id uuid not null references outlets(id), effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to > effective_from),
  exclude using gist(distributor_id with =,outlet_id with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create table partner_contracts (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  version integer not null, source_ref text not null, sample boolean not null default false,
  rate_centavos bigint not null check(rate_centavos between 0 and 100000000),
  minimum_calls integer not null check(minimum_calls between 1 and 200),
  minimum_dwell_ms bigint not null check(minimum_dwell_ms between 0 and 86400000),
  required_kinds text[] not null,
  effective_from timestamptz not null, effective_to timestamptz,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(distributor_id,version), check(effective_to is null or effective_to > effective_from),
  exclude using gist(distributor_id with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create table partner_billing_periods (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  period_from date not null, period_to date not null, evidence_hash text not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(period_to >= period_from), unique(distributor_id,period_from,period_to,evidence_hash)
);
create table partner_billing_lines (
  id uuid primary key default gen_random_uuid(), period_id uuid not null references partner_billing_periods(id),
  profile_id uuid not null references profiles(id), service_date date not null,
  amount_centavos bigint not null check(amount_centavos >= 0), evidence jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(period_id,profile_id,service_date)
);
create table partner_billing_decisions (
  id uuid primary key default gen_random_uuid(), period_id uuid not null unique references partner_billing_periods(id),
  evidence_hash text not null, decision text not null check(decision in ('approved','rejected')),
  reason text not null, actor_id uuid not null references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table partner_commands (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  actor_id uuid not null references profiles(id), request_key text not null, payload_hash text not null, response jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(distributor_id,actor_id,request_key)
);
create table partner_events (
  id uuid primary key default gen_random_uuid(), distributor_id uuid not null references distributors(id),
  actor_id uuid not null references profiles(id), action text not null, details jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- Frozen commercial evidence is append-only. Decisions are separate events.
create function partner_immutable() returns trigger language plpgsql as $$ begin
  raise exception 'Partner evidence is immutable';
end $$;
create trigger partner_lines_immutable before update or delete on partner_billing_lines for each row execute function partner_immutable();
create trigger partner_periods_immutable before update or delete on partner_billing_periods for each row execute function partner_immutable();
create trigger partner_decisions_immutable before update or delete on partner_billing_decisions for each row execute function partner_immutable();
create index partner_billing_partner on partner_billing_periods(distributor_id,period_from,period_to);
create index partner_membership_profile on distributor_users(profile_id,effective_from,effective_to);
