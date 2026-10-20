-- F-111: independent confirmation is not inferred from an entered e-wallet/card reference.
create table fiscal_tender_confirmations (
 id uuid primary key default gen_random_uuid(), payment_id uuid not null unique references van_payments(id),
 decision text not null check(decision in ('confirmed','rejected')), reason text not null,
 actor_profile_id uuid not null references profiles(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create trigger fiscal_tender_confirmations_immutable before update or delete on fiscal_tender_confirmations for each row execute function fiscal_immutable();
create trigger fiscal_tender_capture after insert on fiscal_tender_confirmations for each row execute function fiscal_capture_change();
