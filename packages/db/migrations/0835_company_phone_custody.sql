-- SP-0221: explicit office custody follows the phone key across people and apps.
-- Existing registrations remain unchanged until the office takes a custody action.
create table company_phone_custody (
  key_id text primary key check (key_id ~ '^[0-9a-f]{64}$'),
  device_id uuid not null unique references registered_devices(id),
  state text not null check (state in ('assigned','lost')),
  changed_at timestamptz not null default now()
);

create table company_phone_assignments (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references registered_devices(id) on delete cascade,
  profile_id uuid not null,
  person_name text,
  effective_from timestamptz not null,
  effective_to timestamptz,
  check (effective_to is null or effective_to >= effective_from)
);
create unique index company_phone_assignments_current_uq
  on company_phone_assignments(device_id) where effective_to is null;
create index company_phone_assignments_history_idx
  on company_phone_assignments(device_id,effective_from desc,id);

-- The current registration is the only trustworthy pre-existing assignment fact.
-- Do not invent earlier transfers from unrelated phone events.
insert into company_phone_assignments(device_id,profile_id,person_name,effective_from,effective_to)
select d.id,d.profile_id,p.name,d.created_at,null
from registered_devices d left join profiles p on p.id=d.profile_id where d.status<>'revoked';

create function record_company_phone_assignment() returns trigger language plpgsql as $$
declare at_time timestamptz := clock_timestamp();
begin
  if TG_OP='UPDATE' then
    if NEW.profile_id=OLD.profile_id and (NEW.status='revoked')=(OLD.status='revoked') then
      return NEW;
    end if;
    update company_phone_assignments set effective_to=greatest(effective_from,at_time)
      where device_id=NEW.id and effective_to is null;
  end if;
  if NEW.status <> 'revoked' then
    insert into company_phone_assignments(device_id,profile_id,person_name,effective_from)
      values(NEW.id,NEW.profile_id,(select name from profiles where id=NEW.profile_id),
        case when TG_OP='INSERT' then NEW.created_at else at_time end);
  end if;
  return NEW;
end $$;
create trigger registered_devices_assignment_history
  after insert or update of profile_id,status on registered_devices
  for each row execute function record_company_phone_assignment();
