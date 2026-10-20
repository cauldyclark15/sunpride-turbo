-- F-108/F-109: immutable tax configuration snapshot and the SAP-owned posting seam.
alter table fiscal_registrations add column tax_basis_points integer not null default 1200 check(tax_basis_points between 0 and 10000);
create table fiscal_posting_requests (
 id uuid primary key default gen_random_uuid(), document_id uuid not null unique references fiscal_documents(id),
 effect_key text not null unique, payload jsonb not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger fiscal_posting_requests_immutable before update or delete on fiscal_posting_requests for each row execute function fiscal_immutable();
-- Allocation ownership and approved range identity may not be rewritten, even by ordinary SQL.
create function fiscal_range_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'Fiscal ranges cannot be deleted or recycled'; end if;
 if tg_table_name='fiscal_series' then
  if (to_jsonb(new)-array['next_allocate','updated_at']) is distinct from (to_jsonb(old)-array['next_allocate','updated_at']) or new.next_allocate<old.next_allocate then raise exception 'Approved series identity is immutable'; end if;
 else
  if (to_jsonb(new)-array['next_issue','updated_at']) is distinct from (to_jsonb(old)-array['next_issue','updated_at']) or new.next_issue<old.next_issue then raise exception 'Offline allocation identity is immutable'; end if;
 end if;
 return new;
end; $$;
create trigger fiscal_series_guard before update or delete on fiscal_series for each row execute function fiscal_range_guard();
create trigger fiscal_allocation_guard before update or delete on fiscal_allocations for each row execute function fiscal_range_guard();
