-- F-R01..F-R08: extend the one POS and canonical commercial/inventory authorities.
alter table store_registers add column outlet_id uuid references outlets(id);
alter table store_register_policies add column loyalty_enabled boolean not null default false,
 add column earn_per_centavos bigint not null default 10000 check(earn_per_centavos>0),
 add column point_value_centavos bigint not null default 100 check(point_value_centavos>0),
 add column employee_discount_bps integer not null default 1000 check(employee_discount_bps between 0 and 10000),
 add column pin_salt text, add column pin_hash text, add column pin_key text;
alter table pos_device_modes add column allow_local_switch boolean not null default false;
create table store_sales (
 id uuid primary key, shift_id uuid not null references store_shifts(id),
 order_id uuid not null unique references orders(id), device_id uuid not null references registered_devices(id),
 receipt_number text not null unique, fiscal_document_id uuid not null references fiscal_documents(id),
 movement_id uuid not null references inventory_movements(id), captured_request jsonb not null,
 receipt jsonb not null, sold_at timestamptz not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_tenders (
 id uuid primary key default gen_random_uuid(), shift_id uuid not null references store_shifts(id),
 sale_id uuid not null references store_sales(id), operation_id uuid not null,
 method text not null, reference text, amount_centavos bigint not null,
 label text not null, status text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(operation_id,method), check(amount_centavos<>0)
);
create unique index store_tender_reference on store_tenders(method,lower(reference)) where reference is not null and amount_centavos>0;
create table store_reversals (
 id uuid primary key, sale_id uuid not null unique references store_sales(id),
 shift_id uuid not null references store_shifts(id), kind text not null check(kind in ('void','refund')),
 reason text not null, requested_by uuid not null references profiles(id), decided_by uuid references profiles(id),
 status text not null check(status in ('pending','approved','rejected')),
 request jsonb not null, movement_id uuid references inventory_movements(id), order_id uuid references orders(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_reads (
 id uuid primary key, register_id uuid not null references store_registers(id), shift_id uuid not null references store_shifts(id),
 kind text not null check(kind in ('x','z')), sequence bigint not null,
 snapshot jsonb not null, captured_at timestamptz not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(register_id,kind,sequence)
);
create unique index store_one_z_shift on store_reads(shift_id) where kind='z';
create table store_read_sequences (
 register_id uuid not null references store_registers(id), kind text not null check(kind in ('x','z')),
 next_number bigint not null default 1 check(next_number>0), primary key(register_id,kind),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_reorder_points (
 id uuid primary key default gen_random_uuid(), register_id uuid not null references store_registers(id), product_id uuid not null references products(id),
 source_location_id uuid not null references inventory_locations(id), minimum_base bigint not null check(minimum_base>=0),
 target_base bigint not null check(target_base>minimum_base), effective_from timestamptz not null, effective_to timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 exclude using gist(register_id with =,product_id with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create table store_replenishments (
 id uuid primary key default gen_random_uuid(), rule_id uuid not null references store_reorder_points(id),
 quantity_base bigint not null check(quantity_base>0), status text not null default 'pending' check(status in ('pending','approved','rejected')),
 transfer_id uuid references stock_transfers(id), requested_by uuid not null references profiles(id), decided_by uuid references profiles(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index store_one_suggestion on store_replenishments(rule_id) where status='pending';
create table store_deposits (
 id uuid primary key, register_id uuid not null references store_registers(id), shift_id uuid not null references store_shifts(id),
 bank text not null, reference text not null unique, amount_centavos bigint not null check(amount_centavos>0),
 photo_id uuid not null references files(id), z_read_id uuid not null unique references store_reads(id),
 expected_centavos bigint not null, discrepancy_centavos bigint not null,
 status text not null check(status in ('matched','needs_review','accepted','investigate')),
 requested_by uuid not null references profiles(id), decided_by uuid references profiles(id), decision_note text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_customers (
 id uuid primary key default gen_random_uuid(), phone text not null unique, name text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table store_points (
 id uuid primary key default gen_random_uuid(), customer_id uuid not null references store_customers(id),
 sale_id uuid not null references store_sales(id), delta bigint not null, kind text not null check(kind in ('earn','redeem','reverse')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(sale_id,kind)
);
create table store_daily_targets (
 id uuid primary key default gen_random_uuid(), register_id uuid not null references store_registers(id),
 from_date date not null,to_date date not null, amount_centavos bigint not null check(amount_centavos>=0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(to_date>=from_date), exclude using gist(register_id with =,daterange(from_date,to_date,'[]') with &&)
);
create index store_sales_shift on store_sales(shift_id,sold_at);
create trigger store_sale_immutable before update or delete on store_sales for each row execute function fiscal_immutable();
create trigger store_tender_immutable before update or delete on store_tenders for each row execute function fiscal_immutable();
create trigger store_read_immutable before update or delete on store_reads for each row execute function fiscal_immutable();
create trigger store_points_immutable before update or delete on store_points for each row execute function fiscal_immutable();
create trigger store_sale_audit after insert on store_sales for each row execute function fiscal_capture_change();
create trigger store_read_audit after insert on store_reads for each row execute function fiscal_capture_change();
create trigger store_reversal_audit after insert or update on store_reversals for each row execute function fiscal_capture_change();
create trigger store_deposit_audit after insert or update on store_deposits for each row execute function fiscal_capture_change();
