-- 0822_customer_master_record (SP-0170). Customer = store: the `outlets` row IS the customer
-- (outlets.code = Customer Code, outlets.name = Customer Name, outlets.address = Customer
-- Address one-liner). Every other field of Sunpride's "Customer Information template" lives in
-- the 1:1 side table customer_profiles, in the sheet's order; delivery entries live in
-- customer_ship_tos (one or more per customer). Reference codes are validated by the API with
-- packages/customer-master against customer_reference_values / ph_* (dependent lists cannot be
-- expressed as plain foreign keys). The accounting `customers` row is kept 1:1 with the same
-- code by the customer writer (apps/api/src/domains/masters/customers.js).

create table customer_profiles (
  outlet_id uuid primary key references outlets(id) on delete cascade,
  -- Customer General Information (Customer Name / Customer Address are outlets.name / .address)
  registered_name text,
  trade_name text,
  email text,
  mobile_no text,
  tel_no text,
  tin text,
  tax_classification_code text,
  -- Customer Location (codes are PSGC; names are kept so the one-line address never depends on
  -- the geography load; Geographical Coordinates live in outlet_pins)
  country_code text not null default 'PH',
  region_code text,
  region_name text,
  province_code text,
  province_name text,
  municipality_code text,
  municipality_name text,
  barangay_code text,
  barangay_name text,
  house_no text,
  street1 text,
  street2 text,
  floor text,
  room_stall_no text,
  postal_code text,
  address_custom boolean not null default false,
  -- Customer Assignment
  sales_org_code text,
  sales_office_code text,
  distribution_channel_code text,
  customer_group1_code text,
  customer_group2_code text,
  customer_group_code text,
  type_of_business text,
  sales_partner_code text,
  -- Names of the chosen assignment codes, kept by the writer/loader so readers (analytics,
  -- mobile bootstrap) need one join instead of four list lookups per store.
  distribution_channel_name text,
  customer_group1_name text,
  customer_group2_name text,
  customer_group_name text,
  -- Payment Arrangement
  payment_terms_code text,
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit >= 0),
  pricing_procedure_code text,
  -- Delivery Arrangement (ship-to entries: customer_ship_tos)
  delivering_plant_code text,
  -- ADP Specific (Distribution Channel 40 only)
  distributor_id uuid references distributors(id),
  distributor_code text,
  distributor_name text,
  distributor_customer_code text,
  distribution_mode text,
  sub_distributor_code text,
  sub_distributor_name text,
  distributor_salesman text,
  distributor_salesman_code text,
  truck_serving text,
  truck_code text,
  distributor_hub text,
  cluster_no text,
  cluster_name text,
  -- System
  completeness text not null default 'draft' check (completeness in ('draft','complete')),
  source text not null default 'api',
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create index customer_profiles_assignment on customer_profiles(sales_org_code, distribution_channel_code, customer_group1_code);
create index customer_profiles_customer_group on customer_profiles(customer_group_code);
create index customer_profiles_change_seq_idx on customer_profiles(change_seq);
create index customer_profiles_distributor on customer_profiles(distributor_id);
create trigger customer_profiles_bump_change_seq before update on customer_profiles for each row execute function bump_change_seq();

create table customer_ship_tos (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  ship_to_party text,
  ship_to_address text,
  contact_person text,
  mobile_no text,
  email text,
  same_as_customer boolean not null default false,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  change_seq bigint not null default nextval('change_seq')
);
create unique index customer_ship_tos_ordinal on customer_ship_tos(outlet_id, ordinal) where deleted_at is null;
create index customer_ship_tos_change_seq_idx on customer_ship_tos(change_seq);
create trigger customer_ship_tos_bump_change_seq before update on customer_ship_tos for each row execute function bump_change_seq();

-- One-line Customer Address from the location parts. packages/customer-master formatAddress()
-- is the same rule in JS (a test keeps them identical).
create function customer_address_line(
  p_room text, p_floor text, p_house text, p_street1 text, p_street2 text,
  p_barangay text, p_municipality text, p_province text, p_postal text
) returns text language sql immutable as $$
  select nullif(concat_ws(', ',
    nullif(btrim(p_room),''), nullif(btrim(p_floor),''),
    nullif(btrim(concat_ws(' ', nullif(btrim(p_house),''), nullif(btrim(p_street1),''))),''),
    nullif(btrim(p_street2),''), nullif(btrim(p_barangay),''), nullif(btrim(p_municipality),''),
    nullif(btrim(concat_ws(' ', nullif(btrim(p_province),''), nullif(btrim(p_postal),''))),'')
  ),'')
$$;
