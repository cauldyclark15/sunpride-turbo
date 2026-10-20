-- F-018/F-019/F-020/F-124/F-511. Additive fiscal authority; never a financial ledger.
create table fiscal_registrations (
  id uuid primary key default gen_random_uuid(),
  org_unit_id uuid not null references org_units(id),
  entity_name text not null, branch_name text not null, tin text not null, address text not null,
  device_id uuid references registered_devices(id),
  document_type text not null check(document_type in ('sales_invoice','official_receipt','credit_memo','delivery_receipt')),
  status text not null check(status in ('sample_not_filed','draft','filed','acknowledged','approved','suspended','expired')),
  application_reference text, permit_reference text, evidence_reference text,
  filed_at timestamptz, acknowledged_at timestamptz,
  effective_from timestamptz not null, effective_to timestamptz,
  entered_by uuid not null references profiles(id), verified_by uuid references profiles(id),
  sample boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>effective_from),
  check(status<>'approved' or (not sample and permit_reference is not null and evidence_reference is not null and verified_by is not null and verified_by<>entered_by)),
  check(not sample or status='sample_not_filed')
);
create table fiscal_series (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references fiscal_registrations(id),
  vehicle_id uuid references vehicles(id),
  prefix text not null unique,
  first_serial bigint not null check(first_serial>0), last_serial bigint not null,
  next_allocate bigint not null,
  effective_from timestamptz not null, effective_to timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(last_serial>=first_serial and next_allocate between first_serial and last_serial+1),
  check(effective_to is null or effective_to>effective_from)
);
create table fiscal_allocations (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references fiscal_series(id),
  device_id uuid not null references registered_devices(id),
  profile_id uuid not null references profiles(id),
  request_key uuid not null,
  first_serial bigint not null, last_serial bigint not null, next_issue bigint not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(device_id,request_key), check(last_serial>=first_serial and next_issue between first_serial and last_serial+1)
);
create index fiscal_allocations_device on fiscal_allocations(device_id,series_id);
create table fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references fiscal_allocations(id),
  series_id uuid not null references fiscal_series(id),
  serial bigint not null, document_number text not null unique,
  source_type text not null, source_id uuid not null,
  snapshot jsonb not null, snapshot_hash text not null,
  issued_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(series_id,serial), unique(source_type,source_id)
);
create table fiscal_document_events (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references fiscal_documents(id),
  kind text not null check(kind in ('issued','void','spoiled','reprint','print')),
  request_key uuid not null, reason text not null, actor_profile_id uuid not null references profiles(id),
  facts jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(document_id,request_key)
);
create table fiscal_authority_rules (
  id uuid primary key default gen_random_uuid(), org_unit_id uuid not null references org_units(id),
  kind text not null check(kind in ('price','credit','stock','discount','void')),
  role text not null, channel text not null,
  min_centavos bigint not null check(min_centavos>=0), max_centavos bigint not null,
  self_limit_centavos bigint not null check(self_limit_centavos>=0),
  approver_roles jsonb not null, offline_allowed boolean not null default false,
  effective_from timestamptz not null, effective_to timestamptz,
  sample boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(max_centavos>=min_centavos), check(effective_to is null or effective_to>effective_from)
);
create index fiscal_authority_lookup on fiscal_authority_rules(org_unit_id,kind,role,channel,effective_from);
create table fiscal_override_requests (
  id uuid primary key, rule_id uuid not null references fiscal_authority_rules(id),
  org_unit_id uuid not null references org_units(id),
  requester_id uuid not null references profiles(id), kind text not null, channel text not null,
  amount_centavos bigint not null check(amount_centavos>=0),
  facts jsonb not null, facts_hash text not null, reason text not null,
  requires_second boolean not null, expires_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table fiscal_override_events (
  id uuid primary key default gen_random_uuid(), request_id uuid not null references fiscal_override_requests(id),
  kind text not null check(kind in ('approved','rejected','consumed')),
  actor_profile_id uuid not null references profiles(id), reason text not null,
  code_hash text, operation_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index fiscal_override_decision on fiscal_override_events(request_id) where kind in ('approved','rejected');
create unique index fiscal_override_consumption on fiscal_override_events(request_id) where kind='consumed';
create table fiscal_audit_events (
  id uuid primary key default gen_random_uuid(), table_name text not null, row_id text not null,
  action text not null, actor_subject text not null, before_facts jsonb, after_facts jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index fiscal_audit_search on fiscal_audit_events(table_name,created_at,id);
create function fiscal_immutable() returns trigger language plpgsql as $$
begin raise exception 'Fiscal evidence is append-only'; end; $$;
create trigger fiscal_documents_immutable before update or delete on fiscal_documents for each row execute function fiscal_immutable();
create trigger fiscal_document_events_immutable before update or delete on fiscal_document_events for each row execute function fiscal_immutable();
create trigger fiscal_override_requests_immutable before update or delete on fiscal_override_requests for each row execute function fiscal_immutable();
create trigger fiscal_override_events_immutable before update or delete on fiscal_override_events for each row execute function fiscal_immutable();
create trigger fiscal_audit_events_immutable before update or delete on fiscal_audit_events for each row execute function fiscal_immutable();
-- Existing application audit is immutable too. The pre-existing, explicit sample reset
-- may delete only its proven owned rows; it cannot update audit or delete real evidence.
create function fiscal_guard_audit() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' and current_setting('sunpride.seed_reset',true)='sunpride-demo-v2'
     and to_regclass('pg_temp.seed_owned_reset') is not null then
    if exists(select 1 from pg_temp.seed_owned_reset where table_name=tg_table_name::text and row_id=old.id) then return old; end if;
  end if;
  raise exception 'Audit is append-only';
end; $$;
create trigger fiscal_audit_logs_immutable before update or delete on audit_logs for each row execute function fiscal_guard_audit();
create trigger fiscal_van_audit_immutable before update or delete on van_audit_events for each row execute function fiscal_immutable();
-- F-020: allowlisted facts only: no passwords, auth tokens, raw photos or coordinates.
create function fiscal_audit_facts(row_data jsonb) returns jsonb language sql immutable as $$
 select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(row_data) where key=any(array[
 'id','code','name','status','active','role','org_unit_id','channel','classification',
 'unit_price_centavos','total_centavos','discount_centavos','amount_centavos','amount_minor',
 'effective_from','effective_to','reason','reason_code','method','kind','variance_centavos',
 'expected_centavos','declared_centavos','quantity_base','unit_price_minor','total_minor',
 'source','source_type','source_id','sale_id','trip_id','product_id','price_list_id',
 'first_serial','last_serial','next_allocate','next_issue','registration_id','permit_reference',
 'evidence_reference','document_type','min_centavos','max_centavos','self_limit_centavos','approver_roles','offline_allowed'
 ]);
$$;
create function fiscal_capture_change() returns trigger language plpgsql as $$
declare b jsonb; a jsonb; actor text;
begin
 if tg_op<>'INSERT' then b=fiscal_audit_facts(to_jsonb(old)); end if;
 if tg_op<>'DELETE' then a=fiscal_audit_facts(to_jsonb(new)); end if;
 actor=coalesce(nullif(current_setting('sunpride.actor',true),''),to_jsonb(new)->>'updated_by',to_jsonb(new)->>'actor_subject',to_jsonb(new)->>'approved_by','system:unattributed');
 insert into fiscal_audit_events(table_name,row_id,action,actor_subject,before_facts,after_facts)
 values(tg_table_name,coalesce(a->>'id',b->>'id','unknown'),tg_op,actor,b,a);
 return coalesce(new,old);
end; $$;
do $$ declare t text; begin
 foreach t in array array['products','customers','outlets','org_units','positions','units_of_measure','uom_conversions','price_lists','price_list_lines','orders','order_lines','van_sale_voids','van_returns','van_payments','van_cash_counts','van_stock_counts','van_damage_records','inventory_adjustments','fiscal_registrations','fiscal_series','fiscal_allocations','fiscal_authority_rules','fiscal_override_requests','fiscal_override_events','fiscal_document_events'] loop
 execute format('create trigger fiscal_capture after insert or update or delete on %I for each row execute function fiscal_capture_change()',t);
 end loop;
end; $$;
