-- Test-only stand-in for lane CORE's 0001_platform.sql. Used only by test/schema.test.js so
-- the 0100-0199 domain migrations can run standalone. The real 0001 keeps these names.

create extension if not exists citext;

create sequence if not exists change_seq;

create or replace function bump_change_seq() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.change_seq := nextval('change_seq');
  return new;
end;
$$;

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique,
  password_hash text,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table registered_devices (
  id uuid primary key default gen_random_uuid()
);

create table files (
  id uuid primary key default gen_random_uuid()
);
