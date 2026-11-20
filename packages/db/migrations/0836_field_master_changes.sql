-- SP-0230: append-only, human-readable changes to the actual field reference authorities.
create table field_master_changes (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  record_key text not null,
  label text not null,
  reason text not null check (length(btrim(reason)) > 0),
  actor_profile_id uuid not null references profiles(id),
  actor_name text not null,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index field_master_changes_page on field_master_changes(created_at desc,id desc);
create function field_master_change_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Field master change history cannot be changed or removed';
end $$;
create trigger field_master_change_immutable before update or delete on field_master_changes
  for each row execute function field_master_change_immutable();
