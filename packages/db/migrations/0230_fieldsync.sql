-- FIELDSYNC owns work-day/consent state and projection invalidations only.
create table fieldsync_work_days (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  service_date date not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('end_day', 'daily_close')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, service_date)
);
create trigger fieldsync_work_days_updated before update on fieldsync_work_days
for each row execute function set_updated_at();
create index fieldsync_work_days_open on fieldsync_work_days(service_date) where ended_at is null;

-- Append-only consent history: an offline fix must have had consent when captured.
create table fieldsync_location_consents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  enabled boolean not null,
  effective_from timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index fieldsync_location_consents_person_time on fieldsync_location_consents(profile_id, effective_from desc);
-- Bounded observed effective-day manifest catches scheduled ownership changes
-- whose original write predates a phone's cursor. Old cursors retain their fence.
create table fieldsync_day_manifests (
  profile_id uuid not null references profiles(id),
  service_date date not null,
  stamp text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(profile_id, service_date)
);
create trigger fieldsync_day_manifests_updated before update on fieldsync_day_manifests
for each row execute function set_updated_at();

alter table live_locations add column last_moved_at timestamptz;

-- The engine exposes no cursor-manifest extension. Transactional invalidation rows
-- are therefore the manifest fence: every affected old cursor MUST rebootstrap.
-- No business rows belonging to another lane are changed by these triggers.
create function fieldsync_invalidate_manifest() returns trigger language plpgsql as $$
declare
  row_data jsonb;
  person text;
begin
  row_data := case when TG_OP = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  person := case when TG_ARGV[0] = 'assignee' then row_data->>'assignee_profile_id'
                 when TG_ARGV[0] = 'person' then row_data->>'profile_id' else null end;
  perform pg_advisory_xact_lock(4310002);
  insert into change_log(entity, entity_id, scope_key, op)
  values ('field.manifest', coalesce(person::uuid, '00000000-0000-4000-8000-000000000000'::uuid),
          case when person is null then 'field:reference' else 'profile:' || person end, 'upsert');
  return null;
end;
$$;
create constraint trigger fieldsync_plan_manifest after insert or update or delete on coverage_plans deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('assignee');
create constraint trigger fieldsync_slot_manifest after insert or update or delete on coverage_plan_slots deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('assignee');
create constraint trigger fieldsync_planned_manifest after insert or update or delete on planned_visits deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('assignee');
create constraint trigger fieldsync_employee_manifest after insert or update or delete on employee_assignments deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('person');
create constraint trigger fieldsync_outlet_manifest after insert or update or delete on outlet_assignments deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_owner_manifest after insert or update or delete on territory_ownerships deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_route_manifest after insert or update or delete on route_salespeople deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_task_manifest after insert or update or delete on field_tasks deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('assignee');
create constraint trigger fieldsync_sheet_manifest after insert or update or delete on call_sheet_accounts deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_sheet_line_manifest after insert or update or delete on call_sheet_account_lines deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_product_manifest after insert or update or delete on products deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_barcode_manifest after insert or update or delete on product_barcodes deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_uom_manifest after insert or update or delete on units_of_measure deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_selling_uom_manifest after insert or update or delete on product_selling_uoms deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_conversion_manifest after insert or update or delete on uom_conversions deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_assortment_manifest after insert or update or delete on outlet_assortments deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_assortment_product_manifest after insert or update or delete on outlet_assortment_products deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_rules_manifest after insert or update or delete on visit_activity_rules deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_rule_activities_manifest after insert or update or delete on visit_activity_rule_activities deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_link_manifest after insert or update or delete on outlet_customer_links deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_pin_manifest after insert or update or delete on outlet_pins deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_price_manifest after insert or update or delete on price_list_lines deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_price_list_manifest after insert or update or delete on price_lists deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_promotion_manifest after insert or update or delete on promotions deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_coverage_assignment_manifest after insert or update or delete on coverage_assignments deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('assignee');
create constraint trigger fieldsync_territory_person_manifest after insert or update or delete on territory_salespeople deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('person');
create constraint trigger fieldsync_route_area_manifest after insert or update or delete on route_territories deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_route_master_manifest after insert or update or delete on routes deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_outlet_master_manifest after insert or update or delete on outlets deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
create constraint trigger fieldsync_inventory_location_manifest after insert or update or delete on inventory_locations deferrable initially deferred for each row execute function fieldsync_invalidate_manifest('global');
