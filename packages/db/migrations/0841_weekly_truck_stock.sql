-- SP-0227: weekly truck stock per salesman. Request -> warehouse served -> sold (existing van sales)
-- -> Saturday count with a reason -> office reconciliation. The cashier basis is the SERVED quantity;
-- requested stays for reference and shortfall only.

-- Admin-editable reasons (Setup > Field masters). Used reasons are deactivated, never deleted.
create table truck_stock_reasons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{1,40}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  sort_order integer not null,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index truck_stock_reasons_active_name on truck_stock_reasons(lower(name)) where active;
insert into truck_stock_reasons(code,name,sort_order) values
  ('unsold','Unsold',1),
  ('expired','Expired',2),
  ('damaged','Damaged',3),
  ('missing','Missing',4),
  ('returned_by_customer','Returned by customer',5);
create function truck_stock_reason_keep() returns trigger language plpgsql as $$
begin
  raise exception 'Stock reasons cannot be deleted; deactivate the reason instead';
end $$;
create trigger truck_stock_reason_keep before delete on truck_stock_reasons
  for each row execute function truck_stock_reason_keep();

-- One stock week per salesman, Monday start. remittance_ref is the reserved, nullable link for the
-- separate cash remittance work (SP-0228); nothing here reads or writes cash.
create table truck_weeks (
  id uuid primary key default gen_random_uuid(),
  salesperson_profile_id uuid not null references profiles(id),
  org_unit_id uuid not null,
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'open' check (status in ('open','counted','reviewed')),
  counted_at timestamptz,
  counted_client_op_id text,
  reviewed_at timestamptz,
  reviewed_by uuid references profiles(id),
  review_note text,
  remittance_ref uuid,
  created_by uuid not null references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (salesperson_profile_id, week_start)
);
create index truck_weeks_week on truck_weeks(week_start, org_unit_id);

create table truck_week_lines (
  week_id uuid not null references truck_weeks(id),
  product_id uuid not null references products(id),
  requested_base bigint not null check (requested_base between 0 and 100000000),
  served_base bigint not null check (served_base between 0 and 100000000),
  counted_base bigint check (counted_base between 0 and 100000000),
  reason_id uuid references truck_stock_reasons(id),
  reason_name text,
  count_note text,
  updated_at timestamptz not null default now(),
  primary key (week_id, product_id)
);
