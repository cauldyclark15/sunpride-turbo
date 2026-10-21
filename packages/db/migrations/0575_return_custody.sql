-- F-113: retain unlinked/exception pickup custody without inventing owned stock, cash refunds or credit.
alter table van_returns alter column sale_id drop not null;
alter table van_returns add column custody_only boolean not null default false;
alter table van_returns add column outlet_id uuid references outlets(id);
alter table van_returns add column recorded_by uuid references profiles(id);
create table van_return_reviews (
 id uuid primary key default gen_random_uuid(),
 return_id uuid not null references van_returns(id),
 kind text not null check(kind in ('warehouse_received','returned_to_outlet','disposal_verified','credit_requested')),
 reason text not null,
 actor_profile_id uuid not null references profiles(id),
 facts jsonb not null default '{}',
 created_at timestamptz not null default now(),
 unique(return_id,kind)
);
create trigger van_return_reviews_immutable before update or delete on van_return_reviews for each row execute function fiscal_immutable();
