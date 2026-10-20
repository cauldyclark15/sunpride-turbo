-- F-616 catalogue content augments material/UOM identity; it never authors price,
-- credit or stock. SAP may replace sample content through the same version seam.
create table product_catalogue_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  revision integer not null check(revision>0),
  source text not null check(source in ('sample','sap')),
  source_reference text not null,
  description text not null,
  ingredients text not null,
  allergens text not null,
  storage text not null,
  shelf_life_days integer not null check(shelf_life_days between 0 and 3650),
  case_specifications text not null,
  image_sha256 text,
  image_bytes integer,
  effective_from timestamptz not null,
  effective_to timestamptz,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id,revision),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(product_id with =,tstzrange(effective_from,effective_to,'[)') with &&)
);
create index product_catalogue_versions_effective on product_catalogue_versions(product_id,effective_from);
create trigger product_catalogue_versions_frozen before update or delete on product_catalogue_versions for each row execute function master_versions_frozen();
