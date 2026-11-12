-- 0823_customer_master_samples (SP-0170): move every existing (sample/demo) store onto the
-- client's customer shape, deterministically, and make analytics read the new channel.
--
-- 1. customer_master_legacy_mapping(): the old sample channel keys -> SAP Distribution Channel /
--    Customer Grp 1 / Customer Grp 2 / Customer Group / Type of Business, sales org 1000 (SFI):
--      gt / general trade ........ 30 General Trade, KAS3, GGS GT-Grocery Stores
--      gt named "Sari-sari", sari-sari .. 41 Route Sales, RSF, RSS Sari-Sari Store
--      pmot (public market) ...... 41 Route Sales, RSF, RWM Wet Market, group 82 MARKET
--      supermarket ............... 30 General Trade, KAS3, GSS GT-Supermarket Store
--      kas / mt / modern trade ... 10 Key Accounts, KAS2, KAL Key Accts. Local
--      horeca / food_service ..... 20 Food Service, FRT Restaurant (no Grp 2)
--      institutional ............. 70 Office Sales, OSD, OSC Office Served Cust.
--      distributor ............... 30 General Trade, KAS3, GSD GT-Sub-Distributors, group 65
--      anything else / none ...... 30 General Trade, KAS3, GGS GT-Grocery Stores
--    Independent stores get Customer Group 74 "NO GROUP" (no real chain is invented).
-- 2. customer_master_backfill(actor): for each store without a customer profile: Customer Code
--    aligned with its only linked accounting customer (orders/AR already carry that code, so
--    the store takes it), profile with clearly marked "Sample …" values for required fields the
--    old model never had, Cebu PSGC location by sample territory, one ship-to "same as
--    customer"; the store's existing address line is kept (built only when missing).
--    Idempotent; the demo seed calls it again after seeding a fresh lane.
--    Only SAMPLE stores (seeded by system:sample*, named "Sample …" or coded SMP-/SAMPLE-) get
--    invented sample values. Any other store (real data) gets an honest DRAFT profile: the
--    channel chain mapped from its own channel, its accounting customer's name as Registered
--    Name (that name is never overwritten), its own address/contact, and nothing invented
--    (no sample location, street, tax, terms, office, plant or placeholder mobile); the office
--    completes it before it is approved again through the customer form.
-- 3. analytics_store_scope.channel / .subchannel now read Distribution Channel / Customer Grp 1
--    names (old key only when a store has no profile). customer_master_channel_name() maps an
--    old key to the channel most of its stores moved to; channel targets, people's channel scope
--    and territory channel are re-keyed with it (merged targets are summed, never duplicated).

create function customer_master_legacy_mapping(p_channel text, p_name text,
  out channel_code text, out group1_code text, out group2_code text,
  out customer_group_code text, out type_of_business text)
language sql immutable as $$
  select m.channel_code, m.group1_code, m.group2_code, m.customer_group_code, m.type_of_business
  from (values
    (1,'gt-sari','41','RSF','RSS','74','Sole Proprietor'),
    (2,'gt','30','KAS3','GGS','74','Sole Proprietor'),
    (3,'pmot','41','RSF','RWM','82','Sole Proprietor'),
    (4,'supermarket','30','KAS3','GSS','74','Corporation'),
    (5,'kas','10','KAS2','KAL','74','Corporation'),
    (6,'horeca','20','FRT',null,'74','Corporation'),
    (7,'institutional','70','OSD','OSC','74','Corporation'),
    (8,'distributor','30','KAS3','GSD','65','Corporation'),
    (9,'default','30','KAS3','GGS','74','Sole Proprietor')
  ) m(rank,key,channel_code,group1_code,group2_code,customer_group_code,type_of_business)
  where m.key = case
    when lower(coalesce(p_channel,'')) ~ 'sari' then 'gt-sari'
    when lower(btrim(coalesce(p_channel,''))) in ('gt','general_trade','general trade','general-trade')
      then case when coalesce(p_name,'') ~* 'sari' then 'gt-sari' else 'gt' end
    when lower(btrim(coalesce(p_channel,''))) in ('pmot','public_market','market') then 'pmot'
    when lower(btrim(coalesce(p_channel,''))) in ('supermarket','sm') then 'supermarket'
    when lower(btrim(coalesce(p_channel,''))) in ('kas','mt','modern_trade','modern trade','key_account','key account') then 'kas'
    when lower(btrim(coalesce(p_channel,''))) in ('horeca','food_service','food service','foodservice') then 'horeca'
    when lower(btrim(coalesce(p_channel,''))) in ('institutional','institution','office') then 'institutional'
    when lower(btrim(coalesce(p_channel,''))) in ('distributor','dt','adp') then 'distributor'
    else 'default' end
$$;

-- Sample territory -> Cebu PSGC location (PSGC 3Q-2026 codes; names kept on the profile).
create function customer_master_sample_location(p_territory_code text, p_territory_name text,
  out region_code text, out region_name text, out province_code text, out province_name text,
  out municipality_code text, out municipality_name text, out barangay_code text,
  out barangay_name text, out postal_code text)
language sql immutable as $$
  select '0700000000','Region VII (Central Visayas)','0702200000','Cebu', l.m, l.mn, l.b, l.bn, l.z
  from (select case
      when coalesce(p_territory_name,'') ~* 'mandaue|consolacion' then 1
      when coalesce(p_territory_name,'') ~* 'south' then 3
      when coalesce(p_territory_name,'') ~* 'talisay|minglanilla' then 4
      else 2 end as k) pick
  join (values
    (1,'0731300000','City of Mandaue','0731300003','Banilad','6014'),
    (2,'0730600000','City of Cebu','0730600003','Apas','6000'),
    (3,'0730600000','City of Cebu','0730600005','Basak Pardo','6000'),
    (4,'0702250000','City of Talisay','0702250001','Bulacao','6045')
  ) l(k,m,mn,b,bn,z) on l.k = pick.k
$$;

create function customer_master_backfill(p_actor text) returns jsonb
language plpgsql as $$
declare
  r record;
  m record;
  loc record;
  aligned integer := 0;
  profiled integer := 0;
  v_mobile text;
  v_address text;
  v_credit numeric(14,2);
  v_sample boolean;
  v_contact text;
  real_rows integer := 0;
begin
  for r in
    select o.*, t.code as territory_code, t.name as territory_name,
      link.customer_id, c.code as customer_code, c.name as customer_name, c.credit_limit as customer_credit,
      (select count(*) from outlet_customer_links x where x.customer_id = link.customer_id
         and x.deleted_at is null and (x.effective_to is null or x.effective_to > now())) as customer_links
    from outlets o
    left join lateral (select a.territory_id from outlet_assignments a where a.outlet_id = o.id
      and a.deleted_at is null order by (a.effective_to is null) desc, a.effective_from desc limit 1) a on true
    left join territories t on t.id = a.territory_id
    left join lateral (select l.customer_id from outlet_customer_links l where l.outlet_id = o.id
      and l.deleted_at is null and l.effective_from <= now() and (l.effective_to is null or l.effective_to > now())
      order by l.effective_from desc limit 1) link on true
    left join customers c on c.id = link.customer_id and c.deleted_at is null
    where o.deleted_at is null
      and not exists (select 1 from customer_profiles p where p.outlet_id = o.id)
    order by o.code
  loop
    -- Customer Code: the store takes its only accounting customer's code (1:1, same code).
    if r.customer_code is not null and r.customer_code <> r.code and r.customer_links = 1
       and not exists (select 1 from outlets x where x.organization_id = r.organization_id and x.code = r.customer_code) then
      update outlets set code = r.customer_code where id = r.id;
      r.code := r.customer_code;
      aligned := aligned + 1;
    end if;
    v_sample := coalesce(r.created_by, '') like 'system:sample%'
      or coalesce(r.name, '') ~* '^\s*sample\M' or coalesce(r.code, '') ~* '^(SMP|SAMPLE)-';
    if r.customer_id is not null and r.customer_links = 1 and v_sample then
      update customers set name = r.name where id = r.customer_id and name is distinct from r.name;
    end if;
    select * into m from customer_master_legacy_mapping(r.channel, r.name);
    select * into loc from customer_master_sample_location(r.territory_code, r.territory_name);
    select case when regexp_replace(ct.phone, '\D', '', 'g') ~ '^(09[0-9]{9}|639[0-9]{9})$'
                then regexp_replace(regexp_replace(ct.phone, '\D', '', 'g'), '^63', '0') end,
           nullif(btrim(ct.name), '')
      into v_mobile, v_contact
      from outlet_contacts ct where ct.outlet_id = r.id and ct.deleted_at is null order by ct.ordinal limit 1;
    v_credit := coalesce(r.customer_credit, 0);
    if not v_sample then
      -- Real data: nothing invented; the office completes the profile (draft).
      v_address := nullif(btrim(r.address), '');
      insert into customer_profiles(outlet_id, registered_name, mobile_no, address_custom,
        sales_org_code, distribution_channel_code, customer_group1_code, customer_group2_code,
        customer_group_code, type_of_business, credit_limit, completeness, source, updated_by,
        distribution_channel_name, customer_group1_name, customer_group2_name, customer_group_name)
      values (r.id, coalesce(nullif(btrim(r.customer_name), ''), r.name), v_mobile, v_address is not null,
        '1000', m.channel_code, m.group1_code, m.group2_code, m.customer_group_code, m.type_of_business,
        v_credit, 'draft', 'sp0170-migration', p_actor,
        (select v.name from customer_reference_values v where v.list = 'distribution_channel'
           and v.sales_org_code = '1000' and v.code = m.channel_code),
        (select v.name from customer_reference_values v where v.list = 'customer_group_1'
           and v.sales_org_code = '1000' and v.channel_code = m.channel_code and v.code = m.group1_code),
        (select v.name from customer_reference_values v where v.list = 'customer_group_2'
           and v.sales_org_code = '1000' and v.channel_code = m.channel_code
           and v.group1_code = m.group1_code and v.code = m.group2_code),
        (select v.name from customer_reference_values v where v.list = 'customer_group'
           and v.code = m.customer_group_code));
      insert into customer_ship_tos(outlet_id, ordinal, ship_to_party, ship_to_address, contact_person,
        mobile_no, same_as_customer, updated_by)
      values (r.id, 0, r.name, v_address, v_contact, v_mobile, true, p_actor);
      profiled := profiled + 1;
      real_rows := real_rows + 1;
      continue;
    end if;
    v_mobile := coalesce(v_mobile, '09000000000');
    -- Customer Address: the store's existing one-liner is kept; only a missing one is built.
    v_address := coalesce(nullif(btrim(r.address), ''),
      customer_address_line(null, null, null, 'Sample street', null,
        loc.barangay_name, loc.municipality_name, loc.province_name, loc.postal_code));
    insert into customer_profiles(outlet_id, registered_name, trade_name, email, mobile_no, tel_no, tin,
      tax_classification_code, country_code, region_code, region_name, province_code, province_name,
      municipality_code, municipality_name, barangay_code, barangay_name, street1, postal_code,
      address_custom,
      sales_org_code, sales_office_code, distribution_channel_code, customer_group1_code,
      customer_group2_code, customer_group_code, type_of_business, payment_terms_code, credit_limit,
      pricing_procedure_code, delivering_plant_code, completeness, source, updated_by,
      distribution_channel_name, customer_group1_name, customer_group2_name, customer_group_name)
    values (r.id,
      case when r.name ~* '^sample' then r.name else 'Sample ' || r.name end,
      null, null, v_mobile, null, null,
      '1', 'PH', loc.region_code, loc.region_name, loc.province_code, loc.province_name,
      loc.municipality_code, loc.municipality_name, loc.barangay_code, loc.barangay_name,
      'Sample street', loc.postal_code,
      v_address is distinct from customer_address_line(null, null, null, 'Sample street', null,
        loc.barangay_name, loc.municipality_name, loc.province_name, loc.postal_code),
      '1000', '100', m.channel_code, m.group1_code, m.group2_code, m.customer_group_code,
      m.type_of_business, case when v_credit > 0 then '0005' else 'ZC03' end, v_credit,
      case when m.channel_code in ('10','30') then '1' else '2' end, '1000',
      case when exists (select 1 from outlet_pins p where p.outlet_id = r.id and p.deleted_at is null
        and p.status in ('pending','verified')) then 'complete' else 'draft' end,
      'sp0170-sample-migration', p_actor,
      (select v.name from customer_reference_values v where v.list = 'distribution_channel'
         and v.sales_org_code = '1000' and v.code = m.channel_code),
      (select v.name from customer_reference_values v where v.list = 'customer_group_1'
         and v.sales_org_code = '1000' and v.channel_code = m.channel_code and v.code = m.group1_code),
      (select v.name from customer_reference_values v where v.list = 'customer_group_2'
         and v.sales_org_code = '1000' and v.channel_code = m.channel_code
         and v.group1_code = m.group1_code and v.code = m.group2_code),
      (select v.name from customer_reference_values v where v.list = 'customer_group'
         and v.code = m.customer_group_code));
    insert into customer_ship_tos(outlet_id, ordinal, ship_to_party, ship_to_address, contact_person,
      mobile_no, same_as_customer, updated_by)
    values (r.id, 0, r.name, v_address, 'Sample contact person', v_mobile, true, p_actor);
    update outlets set address = v_address where id = r.id and address is null;
    profiled := profiled + 1;
  end loop;
  if profiled > 0 then
    insert into audit_logs(subject, action, entity_type, entity_id, details)
    values (p_actor, 'customer_master.sample_backfill', 'outlets', 'SP-0170',
      jsonb_build_object('profiled', profiled, 'codesAligned', aligned, 'realDrafts', real_rows)::text);
  end if;
  perform customer_master_rekey_channel_targets();
  return jsonb_build_object('profiled', profiled, 'codesAligned', aligned, 'realDrafts', real_rows);
end $$;

create function customer_master_channel_name(p_key text) returns text
language sql stable as $$
  select case
    when p_key is null or btrim(p_key) = '' then p_key
    when exists (select 1 from customer_reference_values v where v.list = 'distribution_channel' and v.name = p_key) then p_key
    else coalesce(
      (select v.name from outlets o join customer_profiles p on p.outlet_id = o.id
         join customer_reference_values v on v.list = 'distribution_channel'
           and v.sales_org_code = p.sales_org_code and v.code = p.distribution_channel_code
       where o.deleted_at is null and lower(o.channel) = lower(p_key)
       group by v.name, v.code order by count(*) desc, v.code limit 1),
      (select v.name from customer_reference_values v where v.list = 'distribution_channel'
         and v.sales_org_code = '1000' and v.code = (customer_master_legacy_mapping(p_key, null)).channel_code),
      p_key)
  end
$$;

-- Channel targets and people's channel scope follow the analytics channel (Distribution Channel
-- name). An old key whose month already has a target under the new name is added into it; the
-- merged-away row keeps its history but no amount, so every level still sums to company.
create function customer_master_rekey_channel_targets() returns void
language plpgsql as $$
declare
  t record;
  v_key text;
  v_existing uuid;
begin
  for t in
    select * from sales_targets
    where level = 'channel' and deleted_at is null
      and not exists (select 1 from customer_reference_values v where v.list = 'distribution_channel' and v.name = sales_targets.target_key)
    order by month, id
  loop
    v_key := customer_master_channel_name(t.target_key);
    if v_key is null or v_key = t.target_key then continue; end if;
    select id into v_existing from sales_targets
      where month = t.month and level = 'channel' and target_key = v_key and deleted_at is null and id <> t.id
      limit 1;
    if v_existing is null then
      update sales_targets set target_key = v_key where id = t.id;
    else
      update sales_targets set deleted_at = now(), amount_centavos = 0, value = 0,
        notes = concat_ws(' ', notes, 'SP-0170: merged into ' || v_key) where id = t.id;
      update sales_targets set amount_centavos = amount_centavos + coalesce(t.amount_centavos, 0),
        value = round((amount_centavos + coalesce(t.amount_centavos, 0)) / 100.0, 2) where id = v_existing;
    end if;
  end loop;
  update profiles set channel_scope = customer_master_channel_name(channel_scope)
  where channel_scope is not null and channel_scope is distinct from customer_master_channel_name(channel_scope);
  update territories set channel = customer_master_channel_name(channel)
  where channel is not null and channel is distinct from customer_master_channel_name(channel);
end $$;

select customer_master_backfill('system:migration:SP-0170');

-- Analytics reads the client's channel. Same columns in the same order (the view's existing
-- dependants stay valid); channel/subchannel now come from the customer profile, new columns
-- are appended.
create or replace view analytics_store_scope as
select o.id, o.organization_id, o.code, o.name, o.status, o.custodian_org_unit_id,
  coalesce(cm.distribution_channel_name, o.channel) as channel,
  coalesce(cm.customer_group1_name, o.subchannel) as subchannel,
  o.classification, o.address, o.directions, o.sales_potential, o.preferred_weekday,
  o.visit_frequency_days, o.visit_window, o.enrolment_status, o.created_by, o.created_at,
  o.updated_at, o.deleted_at, o.change_seq, o.search_vector,
  a.territory_id, t.name as territory_name,
  coalesce(own.org_unit_id, o.custodian_org_unit_id) as owner_unit_id,
  link.customer_id, c.code as customer_code, c.credit_limit, a.route_id,
  coalesce(a.cycle_days, o.visit_frequency_days) as cycle_days,
  cm.sales_org_code, cm.distribution_channel_code, cm.customer_group1_code,
  cm.customer_group2_code, cm.customer_group2_name, cm.customer_group_code,
  cm.customer_group_name, o.channel as legacy_channel
from outlets o
left join lateral (select a_1.* from outlet_assignments a_1 where a_1.outlet_id = o.id
  and a_1.deleted_at is null and a_1.effective_from <= now() and (a_1.effective_to is null or a_1.effective_to > now())
  order by a_1.effective_from desc limit 1) a on true
left join territories t on t.id = a.territory_id
left join lateral (select x.* from territory_ownerships x where x.territory_id = a.territory_id
  and x.deleted_at is null and x.effective_from <= now() and (x.effective_to is null or x.effective_to > now())
  order by x.effective_from desc limit 1) own on true
left join lateral (select l.* from outlet_customer_links l where l.outlet_id = o.id
  and l.deleted_at is null and l.effective_from <= now() and (l.effective_to is null or l.effective_to > now())
  order by l.effective_from desc limit 1) link on true
left join customers c on c.id = link.customer_id and c.deleted_at is null
left join customer_profiles cm on cm.outlet_id = o.id and cm.deleted_at is null
where o.deleted_at is null;

-- Cached sales lines carry the channel they were computed with; recompute it from the scope.
update analytics_sales_cache c set channel = s.channel
from analytics_store_scope s where s.id = c.store_id and c.channel is distinct from s.channel;
