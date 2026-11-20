-- SP-0219: keep the legacy default mode, and store the person's enabled set.
alter table profiles add column app_modes text[];
update profiles set app_modes = array[app_mode];
alter table profiles alter column app_modes set not null;
alter table profiles alter column app_modes set default array['mapping']::text[];
alter table profiles add constraint profiles_app_modes_check check (
  cardinality(app_modes) between 1 and 3
  and app_modes <@ array['mapping','visits','selling']::text[]
  and array_position(app_modes, null) is null
  and app_mode = any(app_modes)
);

-- Old single-mode writers still replace the mode. New writers supply the whole set
-- and retain a valid default for older phones. Inserts without a set keep mapping.
create function sync_profile_app_modes() returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    if new.app_modes is null or (new.app_modes = array['mapping']::text[] and new.app_mode <> 'mapping') then
      new.app_modes := array[new.app_mode];
    end if;
  elsif new.app_modes is not distinct from old.app_modes and new.app_mode is distinct from old.app_mode then
    new.app_modes := array[new.app_mode];
    new.selling := new.app_mode = 'selling';
  elsif new.app_modes is distinct from old.app_modes then
    if not (new.app_mode = any(new.app_modes)) then
      new.app_mode := new.app_modes[1];
    end if;
    new.selling := 'selling' = any(new.app_modes);
  end if;
  return new;
end;
$$;
create trigger profiles_sync_app_modes before insert or update on profiles
  for each row execute function sync_profile_app_modes();
