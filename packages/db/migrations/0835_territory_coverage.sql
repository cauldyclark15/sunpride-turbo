-- SP-0222: chain/key-account groups are distinct from SAP customer classifications.
-- Existing territories and assignments retain their meaning without any coverage rules.
alter table territories add column territory_type text not null default 'location'
  check (territory_type in ('location','customer_group'));
create table customer_groups (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index customer_groups_name_key on customer_groups(lower(name)) where deleted_at is null;
alter table outlets add column customer_group_id uuid references customer_groups(id);
create index outlets_customer_group_idx on outlets(customer_group_id);
create index customer_profiles_place_idx on customer_profiles(municipality_code,barangay_code) where deleted_at is null;
create table territory_coverage (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories(id),
  municipality_code text references ph_municipalities(code),
  barangay_code text references ph_barangays(code),
  customer_group_id uuid references customer_groups(id),
  check (num_nonnulls(municipality_code,barangay_code,customer_group_id)=1)
);
create index territory_coverage_territory_idx on territory_coverage(territory_id);
create index territory_coverage_municipality_idx on territory_coverage(municipality_code);
create index territory_coverage_barangay_idx on territory_coverage(barangay_code);
create index territory_coverage_group_idx on territory_coverage(customer_group_id);
alter table outlet_assignments add column assignment_source text not null default 'manual'
  check (assignment_source in ('manual','automatic'));

-- Persist automatic assignments through the SAME authority used by scope, rosters,
-- planning, sync and analytics. Preserve past intervals; rebuild only now/future.
-- Precedence: manual > customer group > barangay > municipality. Rule spans respect
-- territory start/end dates. A future manual interval masks only its own interval.
create function refresh_outlet_coverage(p_outlet uuid) returns void language plpgsql as $$
declare
  v_now timestamptz := statement_timestamp();
  v_desired jsonb;
  v_current jsonb;
begin
  perform pg_advisory_xact_lock(7343001);
  with candidates as (
    select distinct t.id territory_id,
      case when c.customer_group_id is not null then 3 when c.barangay_code is not null then 2 else 1 end priority,
      tstzrange(greatest(v_now,t.effective_from),t.effective_to,'[)') span
    from outlets o left join customer_profiles p on p.outlet_id=o.id and p.deleted_at is null
    join territory_coverage c on
      (c.customer_group_id=o.customer_group_id or c.barangay_code=p.barangay_code or c.municipality_code=p.municipality_code)
    join territories t on t.id=c.territory_id
    where o.id=p_outlet and o.deleted_at is null and o.status<>'inactive'
      and t.deleted_at is null and t.status='active' and (t.effective_to is null or t.effective_to>greatest(v_now,t.effective_from))
  ), available as (
    select c.territory_id, unnest(tstzmultirange(c.span) - coalesce((
      select range_agg(mask.span) from (
        select tstzrange(a.effective_from,a.effective_to,'[)') span
          from outlet_assignments a where a.outlet_id=p_outlet and a.assignment_source='manual' and a.deleted_at is null
        union all
        select x.span from candidates x where x.priority>c.priority
      ) mask
    ),'{}'::tstzmultirange)) span from candidates c
  ), combined as (
    select territory_id,unnest(range_agg(span)) span from available group by territory_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('territory',territory_id,'from',lower(span),'to',upper(span)) order by territory_id,lower(span)),'[]')
    into v_desired from combined where not isempty(span);
  select coalesce(jsonb_agg(jsonb_build_object('territory',territory_id,'from',greatest(effective_from,v_now),'to',effective_to) order by territory_id,effective_from),'[]')
    into v_current from outlet_assignments where outlet_id=p_outlet and assignment_source='automatic'
      and deleted_at is null and (effective_to is null or effective_to>greatest(v_now,effective_from));
  if v_desired=v_current then return; end if;
  update outlet_assignments set effective_to=greatest(effective_from,v_now)
    where outlet_id=p_outlet and assignment_source='automatic' and deleted_at is null
      and (effective_to is null or effective_to>v_now);
  insert into outlet_assignments(outlet_id,territory_id,effective_from,effective_to,actor_subject,reason,assignment_source)
    select p_outlet,(r->>'territory')::uuid,(r->>'from')::timestamptz,(r->>'to')::timestamptz,
      coalesce(nullif(current_setting('sunpride.actor',true),''),'system:territory-coverage'),
      'Automatic territory coverage','automatic' from jsonb_array_elements(v_desired) r;
end $$;

create function refresh_all_territory_coverage() returns void language plpgsql as $$
declare r record;
begin
  perform pg_advisory_xact_lock(7343001);
  for r in select id from outlets where deleted_at is null order by id loop
    perform refresh_outlet_coverage(r.id);
  end loop;
end $$;

-- Includes office edits, field approvals, bulk uploads and other canonical writers.
create function customer_place_coverage_changed() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    perform refresh_outlet_coverage(old.outlet_id);
    return old;
  end if;
  perform refresh_outlet_coverage(new.outlet_id);
  return new;
end $$;
create trigger customer_place_coverage_insert after insert or delete on customer_profiles
  for each row execute function customer_place_coverage_changed();
create trigger customer_place_coverage_update after update on customer_profiles for each row
  when (old.municipality_code is distinct from new.municipality_code or old.barangay_code is distinct from new.barangay_code or old.deleted_at is distinct from new.deleted_at)
  execute function customer_place_coverage_changed();
create function outlet_group_coverage_changed() returns trigger language plpgsql as $$
begin
  perform refresh_outlet_coverage(new.id);
  return new;
end $$;
create trigger outlet_group_coverage_update after update on outlets for each row
  when (old.customer_group_id is distinct from new.customer_group_id or old.status is distinct from new.status or old.deleted_at is distinct from new.deleted_at)
  execute function outlet_group_coverage_changed();
