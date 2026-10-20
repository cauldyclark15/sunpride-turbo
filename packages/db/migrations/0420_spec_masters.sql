-- F-009/F-010/F-013/F-014/F-017/F-305: one identity and effective revision
-- mechanism for governed masters; kinds have independent validated DTO contracts.
create table master_definitions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('geography','beat','channel','subchannel','class_policy','msl','chain','banner','branch')),
  code text not null,
  org_unit_id uuid references org_units(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(kind,code)
);
create table master_versions (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references master_definitions(id),
  version integer not null check(version>0),
  label text not null,
  status text not null check(status in ('active','inactive')),
  data jsonb not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  actor_profile_id uuid references profiles(id),
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(master_id,version),
  check(effective_to is null or effective_to>effective_from),
  exclude using gist(master_id with =, tstzrange(effective_from,effective_to,'[)') with &&)
);
create index master_versions_effective on master_versions(master_id,effective_from);
create table master_channel_aliases (
  id uuid primary key default gen_random_uuid(),
  legacy_key text not null unique,
  channel_id uuid not null references master_definitions(id),
  subchannel_id uuid references master_definitions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Canonical mapped IDs coexist with source keys so historical commercial facts are
-- not repriced or silently relabelled during migration. Source strings are provenance.
alter table outlets add column channel_id uuid references master_definitions(id);
alter table outlets add column subchannel_id uuid references master_definitions(id);
alter table customers add column channel_id uuid references master_definitions(id);
alter table territories add column geography_id uuid references master_definitions(id);
alter table outlets add column geography_id uuid references master_definitions(id);
create table outlet_class_decisions (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  policy_version_id uuid not null references master_versions(id),
  inputs jsonb not null,
  potential_centavos bigint not null check(potential_centavos>=0),
  derived_class text not null check(derived_class in ('A','B','C','D')),
  assigned_class text not null check(assigned_class in ('A','B','C','D')),
  actor_profile_id uuid not null references profiles(id),
  reason text not null,
  effective_from timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- F-012: preserve source/historical IDs. Never rewrite signed visit/order facts.
create table outlet_survivors (
  id uuid primary key default gen_random_uuid(),
  source_outlet_id uuid not null unique references outlets(id),
  survivor_outlet_id uuid not null references outlets(id),
  actor_profile_id uuid not null references profiles(id),
  reason text not null,
  effective_from timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(source_outlet_id<>survivor_outlet_id)
);
create index outlet_survivors_target on outlet_survivors(survivor_outlet_id);
-- F-011: immutable survey capture, separately authored review. Device clientOpId
-- supplies replay identity; raw evidence never goes into general audit details.
create table census_batches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  org_unit_id uuid not null references org_units(id),
  expected_outlets integer not null check(expected_outlets>0),
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table census_captures (
  id uuid primary key,
  batch_id uuid not null references census_batches(id),
  actor_profile_id uuid not null references profiles(id),
  payload_hash text not null,
  name text not null,
  address text not null,
  latitude double precision not null check(latitude between -90 and 90),
  longitude double precision not null check(longitude between -180 and 180),
  accuracy_meters double precision not null check(accuracy_meters>0 and accuracy_meters<50),
  captured_at timestamptz not null,
  owner_name text not null,
  owner_phone text not null,
  channel_id uuid not null references master_definitions(id),
  subchannel_id uuid not null references master_definitions(id),
  estimated_class text not null check(estimated_class in ('A','B','C','D')),
  photo_file_id uuid not null references files(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table census_reviews (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null unique references census_captures(id),
  decision text not null check(decision in ('accept','reject','duplicate')),
  outlet_id uuid references outlets(id),
  actor_profile_id uuid not null references profiles(id),
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Revision content, classification and merge decisions are append-only. Closing an
-- open revision is the only allowed version update (content remains frozen).
create function masters_immutable() returns trigger language plpgsql as $$
begin raise exception 'Master decision is append-only'; end $$;
create trigger outlet_class_decisions_immutable before update or delete on outlet_class_decisions for each row execute function masters_immutable();
create trigger outlet_survivors_immutable before update or delete on outlet_survivors for each row execute function masters_immutable();
create trigger census_captures_immutable before update or delete on census_captures for each row execute function masters_immutable();
create trigger census_reviews_immutable before update or delete on census_reviews for each row execute function masters_immutable();
create function master_versions_frozen() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'Master version is append-only'; end if;
  if old.effective_to is not null or new.effective_to is null or
     (to_jsonb(new)-'effective_to') is distinct from (to_jsonb(old)-'effective_to') then
    raise exception 'Master version content is immutable';
  end if;
  return new;
end $$;
create trigger master_versions_frozen before update or delete on master_versions for each row execute function master_versions_frozen();
