-- 0821_ph_geography (SP-0170): Country -> Region -> Province -> Municipality/City -> Barangay,
-- plus Postal Codes per municipality, for the customer master's dependent dropdowns.
--
-- Dataset (loaded by packages/db/scripts/seed-ph-geography.js from
-- packages/db/reference/ph-geography-psgc-2026q3.json, built by scripts/build-ph-geography.py):
--   * Philippine Standard Geographic Code (PSGC), Philippine Statistics Authority,
--     "Third Quarter 2026 PSGC Updates" (PSA ref. 2026-331, publication date 30 September 2026,
--     released 2026-10-12), PSGC-3Q-2026-Publication-Datafile.xlsx
--     sha256 8aad47f84e4f6317dc4222b9fe35d36b5d71f2b74ad8f0c7622289c131dc9a59.
--     18 regions, 87 provinces (NCR districts kept as pseudo-provinces so NCR cities have a
--     province), 1,655 municipalities/cities, 42,010 barangays.
--   * Postal codes: PHLPost ZIP code locator (phlpost.gov.ph, raw extract committed as
--     reference/phlpost-zip-locator-raw.json) first, community ZIP list (grit.ph extract,
--     2024-01-04) for the remainder: 1,703 codes over 1,495 municipalities; 338 PHLPost rows did
--     not match a PSGC municipality and are not loaded.
-- Tables are reference data: the loader upserts by PSGC code and records the release it loaded.

create table ph_geography_releases (
  id uuid primary key default gen_random_uuid(),
  release text not null unique,
  source jsonb not null,
  counts jsonb not null,
  loaded_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ph_regions (
  code text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ph_provinces (
  code text primary key,
  region_code text not null references ph_regions(code),
  name text not null,
  kind text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ph_provinces_region on ph_provinces(region_code, name);

create table ph_municipalities (
  code text primary key,
  province_code text not null references ph_provinces(code),
  region_code text not null references ph_regions(code),
  name text not null,
  kind text not null,
  city_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ph_municipalities_province on ph_municipalities(province_code, name);

create table ph_barangays (
  code text primary key,
  municipality_code text not null references ph_municipalities(code),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ph_barangays_municipality on ph_barangays(municipality_code, name);

create table ph_postal_codes (
  municipality_code text not null references ph_municipalities(code),
  postal_code text not null check (postal_code ~ '^[0-9]{4}$'),
  area text,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (municipality_code, postal_code)
);
create index ph_postal_codes_code on ph_postal_codes(postal_code);
