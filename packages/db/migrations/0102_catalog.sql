-- 0102_catalog: Units of measure, products, customers, warehouses.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: units_of_measure, products, product_selling_uoms, customers, warehouses, uom_conversions, product_barcodes, sales_assignments.

-- unitsOfMeasure [synced]
create table units_of_measure (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  code text not null,
  name text not null,
  dimension text not null check (dimension in ('count', 'mass', 'volume', 'length', 'area')),
  decimal_places integer not null,
  active boolean not null,
  external_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index units_of_measure_organization_id_and_code_key on units_of_measure (organization_id, code);
create index units_of_measure_organization_id_and_dimension_and_active_idx on units_of_measure (organization_id, dimension, active);
create index units_of_measure_change_seq_idx on units_of_measure (change_seq);
create trigger units_of_measure_bump_change_seq before update on units_of_measure for each row execute function bump_change_seq();

-- products [synced]
create table products (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  category text not null,
  uom text not null,
  unit_price numeric(14,2) not null,
  active boolean not null,
  external_id text,
  organization_id text,
  base_uom_id uuid,
  quantity_scale bigint,
  tracking_mode text check (tracking_mode in ('none', 'lot', 'serial')),
  allocation_policy text check (allocation_policy in ('fefo', 'fifo', 'explicit_only')),
  policy_version integer,
  catalog_source text,
  catalog_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index products_code_key on products (code);
create index products_category_idx on products (category);
create index products_change_seq_idx on products (change_seq);
create trigger products_bump_change_seq before update on products for each row execute function bump_change_seq();

-- products (products.sellingUomIds[]) [synced]
create table product_selling_uoms (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  ordinal integer not null,
  uom_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index product_selling_uoms_parent_ordinal_key on product_selling_uoms (product_id, ordinal);
create index product_selling_uoms_change_seq_idx on product_selling_uoms (change_seq);
create trigger product_selling_uoms_bump_change_seq before update on product_selling_uoms for each row execute function bump_change_seq();

-- customers [synced]
create table customers (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  channel text not null,
  territory text not null,
  credit_limit numeric(14,2) not null,
  active boolean not null,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index customers_code_key on customers (code);
create index customers_territory_idx on customers (territory);
create index customers_change_seq_idx on customers (change_seq);
create trigger customers_bump_change_seq before update on customers for each row execute function bump_change_seq();

-- warehouses
create table warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  location text not null,
  active boolean not null,
  external_id text,
  organization_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index warehouses_code_key on warehouses (code);
create trigger warehouses_set_updated_at before update on warehouses for each row execute function set_updated_at();

-- uomConversions [synced]
create table uom_conversions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid,
  from_uom_id uuid not null,
  to_uom_id uuid not null,
  numerator bigint not null,
  denominator bigint not null,
  rounding_mode text not null check (rounding_mode in ('exact', 'half_up', 'floor', 'ceiling')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  active boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq'),
  constraint uom_conversions_range_ck check (effective_to is null or effective_to >= effective_from),
  constraint uom_conversions_no_overlap exclude using gist (organization_id with =, product_id with =, from_uom_id with =, to_uom_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (active and deleted_at is null)
);
create index uom_conversions_organization_id_and_product_id_and_fro_eb098bd4 on uom_conversions (organization_id, product_id, from_uom_id, to_uom_id);
create index uom_conversions_organization_id_and_from_uom_id_and_to_66691ceb on uom_conversions (organization_id, from_uom_id, to_uom_id);
create index uom_conversions_change_seq_idx on uom_conversions (change_seq);
create trigger uom_conversions_bump_change_seq before update on uom_conversions for each row execute function bump_change_seq();

-- productBarcodes [synced]
create table product_barcodes (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  product_id uuid not null,
  barcode text not null,
  uom_id uuid not null,
  active boolean not null,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index product_barcodes_organization_id_and_barcode_idx on product_barcodes (organization_id, barcode);
create index product_barcodes_organization_id_and_product_id_idx on product_barcodes (organization_id, product_id);
create unique index product_barcodes_active_barcode_key on product_barcodes (organization_id, barcode) where active;
create index product_barcodes_change_seq_idx on product_barcodes (change_seq);
create trigger product_barcodes_bump_change_seq before update on product_barcodes for each row execute function bump_change_seq();

-- salesAssignments
create table sales_assignments (
  id uuid primary key default gen_random_uuid(),
  salesperson_subject text not null,
  customer_code text not null,
  territory text not null,
  active boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sales_assignments_salesperson_idx on sales_assignments (salesperson_subject);
create index sales_assignments_customer_idx on sales_assignments (customer_code);
create trigger sales_assignments_set_updated_at before update on sales_assignments for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table products add constraint products_base_uom_id_fkey foreign key (base_uom_id) references units_of_measure(id);
alter table product_selling_uoms add constraint product_selling_uoms_product_id_fkey foreign key (product_id) references products(id) on delete cascade;
alter table product_selling_uoms add constraint product_selling_uoms_uom_id_fkey foreign key (uom_id) references units_of_measure(id);
alter table uom_conversions add constraint uom_conversions_product_id_fkey foreign key (product_id) references products(id);
alter table uom_conversions add constraint uom_conversions_from_uom_id_fkey foreign key (from_uom_id) references units_of_measure(id);
alter table uom_conversions add constraint uom_conversions_to_uom_id_fkey foreign key (to_uom_id) references units_of_measure(id);
alter table product_barcodes add constraint product_barcodes_product_id_fkey foreign key (product_id) references products(id);
alter table product_barcodes add constraint product_barcodes_uom_id_fkey foreign key (uom_id) references units_of_measure(id);

-- Supporting indexes for foreign keys without a leading index.
create index products_base_uom_id_fk_idx on products (base_uom_id);
create index product_selling_uoms_uom_id_fk_idx on product_selling_uoms (uom_id);
create index uom_conversions_product_id_fk_idx on uom_conversions (product_id);
create index uom_conversions_from_uom_id_fk_idx on uom_conversions (from_uom_id);
create index uom_conversions_to_uom_id_fk_idx on uom_conversions (to_uom_id);
create index product_barcodes_product_id_fk_idx on product_barcodes (product_id);
create index product_barcodes_uom_id_fk_idx on product_barcodes (uom_id);
