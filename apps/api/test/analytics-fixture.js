import { sha256Hex } from "../src/core/util.js";
import { dateOf, addDays } from "../src/domains/analytics/measures.js";

/** SQL-only reproducible performance fixture, not the demo seed. 300 stores / 12 agents.
 * @param {any} h @param {number} [days] */
export async function analyticsFixture(h, days = 3) {
  const db = new Proxy(h.db, {
      apply(target, thisArg, args) {
        const query = Reflect.apply(target, thisArg, args);
        if (Array.isArray(args[0]) && Object.hasOwn(args[0], "raw"))
          return query.catch((/** @type {any} */ e) => {
            console.error("Fixture SQL:", args[0].join(" ? "));
            throw e;
          });
        return query;
      },
    }),
    today = dateOf(Date.now()),
    start = addDays(today, -(days - 1));
  const [root] =
    await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('fixture','ROOT','Company','company','active','2020-01-01') returning id`;
  const [a] =
    await db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('fixture','A','Team A','region',${root.id},'active','2020-01-01') returning id`;
  const [b] =
    await db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('fixture','B','Team B','region',${root.id},'active','2020-01-01') returning id`;
  const [position] =
    await db`insert into positions(organization_id,code,label,category,active) values('fixture','FIELD','Field','field',true) returning id`;
  await db`insert into position_standards(organization_id,position_id,effective_from,productive_call_rule,selling_weekdays,source_ref,work_with_weekly_min) values('fixture',${position.id},'2020-01-01','any_listed_activity',array[1,2,3,4,5,6],'fixture',1)`;
  const [u] =
    await db`insert into users(email,password_hash) values('analytics@example.com','not-a-password-hash') returning id`;
  const [boss] =
    await db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},'Owner','analytics@example.com','super_admin','active',${root.id}) returning id`;
  const [sup] =
    await db`insert into profiles(auth_subject,name,email,role,status,org_unit_id) values('supervisor-a','Supervisor A','supervisor@example.com','manager','active',${a.id}) returning id`;
  await db`insert into profiles(auth_subject,name,email,role,status,org_unit_id,position_id,channel_scope,employee_code)
    select 'agent-'||i,'Agent '||i,'agent'||i||'@example.com','sales','active',case when i%4<2 then ${a.id}::uuid else ${b.id}::uuid end,${position.id},(array['GT','PMOT','SM','KAS'])[i%4+1],i::text from generate_series(0,11) i`;
  await db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,supervisor_id,effective_from,actor_subject,reason)
    select id,org_unit_id,role,position_id,${sup.id},'2020-01-01','fixture','fixture' from profiles where role='sales'`;
  await db`insert into territories(organization_id,code,name,channel,status,effective_from,created_by)
    select 'fixture','T'||i,'Territory '||i,(array['GT','PMOT','SM','KAS'])[i+1],'active','2020-01-01','fixture' from generate_series(0,3) i`;
  await db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason)
    select id,case when substring(code,2)::int<2 then ${a.id}::uuid else ${b.id}::uuid end,'2020-01-01','fixture','fixture' from territories`;
  await db`insert into territory_salespeople(territory_id,profile_id,kind,effective_from,actor_subject,reason)
    select t.id,p.id,'primary','2020-01-01','fixture','fixture' from profiles p join territories t on t.channel=p.channel_scope where p.role='sales'`;
  await db`insert into customers(code,name,channel,territory,credit_limit,active)
    select 'C'||i,'Customer '||i,(array['GT','PMOT','SM','KAS'])[i%4+1],'T'||i%4,100000,true from generate_series(0,299) i`;
  await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by)
    select 'fixture','S'||i,'Store '||i,'active',case when i%4<2 then ${a.id}::uuid else ${b.id}::uuid end,(array['GT','PMOT','SM','KAS'])[i%4+1],'fixture' from generate_series(0,299) i`;
  await db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason)
    select o.id,t.id,'2020-01-01','fixture','fixture' from outlets o join territories t on t.channel=o.channel`;
  await db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason)
    select o.id,c.id,'fixture','2020-01-01','fixture','fixture' from outlets o join customers c on substring(o.code,2)=substring(c.code,2)`;
  await db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('fixture','PCS','Pieces','count',0,true),('fixture','CS','Cases','count',0,true)`;
  const [piece] = await db`select id from units_of_measure where code='PCS'`;
  const [cs] = await db`select id from units_of_measure where code='CS'`;
  await db`insert into products(code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale) values('P1','Canned meat','Canned','PCS',101.23,true,'fixture',${piece.id},1),('P2','Frozen meat','Frozen','PCS',5.13,true,'fixture',${piece.id},1)`;
  await db`insert into uom_conversions(organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) select 'fixture',id,${cs.id},${piece.id},24,1,'exact','2020-01-01',true from products`;
  await db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
    values('fixture',${a.id},'A','A-DEPOT','Team A depot','warehouse',true,true,true,true,false),('fixture',${b.id},'B','B-DEPOT','Team B depot','warehouse',true,true,true,true,false)`;
  await db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_base,inventory_value_minor,damaged_base)
    select p.code,l.code,49,0,49,now(),'fixture',p.id,l.id,49,49,49000,0 from products p cross join inventory_locations l`;
  await db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,created_at,source_location_id)
    select 'fixture','F-'||c.code||'-'||d::text,'F-'||c.code||'-'||d::text,c.code,'agent-'||(substring(c.code,2)::int%12),case when substring(c.code,2)::int%5=0 then 'pending_approval' when substring(c.code,2)::int%5=1 then 'fulfilled' else 'approved' end,106.36,106.36,d::date+time '10:00' at time zone 'Asia/Manila',l.id
    from customers c cross join generate_series(${start}::date,${today}::date,'1 day'::interval) d join inventory_locations l on l.code=case when substring(c.code,2)::int%4<2 then 'A-DEPOT' else 'B-DEPOT' end`;
  await db`insert into order_lines(order_id,product_code,description,quantity,unit_price,line_total) select o.id,p.code,p.name,1,p.unit_price,p.unit_price from orders o cross join products p`;
  const [plan] =
    await db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,content_revision,created_by,updated_by)
    select 'fixture',id,${today.slice(0, 7)},1,'monthly',org_unit_id,${start},${addDays(today, 1)},${start},${addDays(today, 1)},'active','fixture',now(),1,'fixture','fixture' from profiles where auth_subject='agent-0' returning id,assignee_profile_id`;
  const [store] = await db`select id from outlets where code='S0'`;
  const [slot] =
    await db`insert into coverage_plan_slots(slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,sequence,expected_duration_minutes,content_revision,updated_by)
    values('slot',${plan.id},${plan.assignee_profile_id},${today},'outlet_visit',${store.id},1,10,1,'fixture') returning id`;
  const [planned] =
    await db`insert into planned_visits(generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,expected_duration_minutes,generated_at)
    values('planned',${plan.id},1,${slot.id},${plan.assignee_profile_id},${store.id},${today},'planned',${{}},10,now()) returning id`;
  const [visit] =
    await db`insert into visit_executions(organization_id,client_visit_id,planned_visit_id,plan_id,slot_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time,started_at,ended_at,call_duration_ms)
    values('fixture','visit',${planned.id},${plan.id},${slot.id},${plan.assignee_profile_id},${store.id},${a.id},${today},'planned','completed','verified',now(),${today + "T09:00:00+08:00"},${today + "T09:30:00+08:00"},1800000) returning id`;
  await db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values('fixture',${a.id},${visit.id},${plan.assignee_profile_id},${store.id},'merchandising',${{}},now(),now())`;
  const [customer] = await db`select id from customers where code='C0'`;
  await db`insert into field_collections(organization_id,org_unit_id,customer_id,outlet_id,visit_id,assignee_profile_id,amount_minor,currency,method,reference,status,device_time,server_time)
    values('fixture',${a.id},${customer.id},${store.id},${visit.id},${plan.assignee_profile_id},12345,'PHP','cash','fixture','recorded',now(),now())`;
  const token = "sps_analytics_fixture_token";
  await db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
  h.setHooks({
    loadProfile: async (/** @type {any} */ db, /** @type {string} */ id) => {
      const [p] = await db`select * from profiles where user_id=${id}`;
      return p
        ? {
            id: p.id,
            userId: id,
            name: p.name,
            role: p.role,
            orgUnitId: p.org_unit_id,
            status: p.status,
          }
        : null;
    },
    scopeUnitIds: async (/** @type {any} */ _db, /** @type {any} */ actor) =>
      actor.orgUnitId === root.id ? [root.id, a.id, b.id] : [actor.orgUnitId],
    unitInScope: async (
      /** @type {any} */ _db,
      /** @type {any} */ actor,
      /** @type {string} */ id,
    ) => actor.orgUnitId === root.id || actor.orgUnitId === id,
  });
  const cookie = `sp_session=${token}`;
  return {
    root: root.id,
    a: a.id,
    b: b.id,
    boss: boss.id,
    user: u.id,
    supervisor: sup.id,
    agent: plan.assignee_profile_id,
    store: store.id,
    visit: visit.id,
    plan: plan.id,
    planned: planned.id,
    cookie,
    today,
    start,
    /** @param {string} path */ get: (path) =>
      h.fetch(path, { headers: { cookie, connection: "close" } }),
    /** @param {string} path @param {any} body */ post: (path, body) =>
      h.fetch(path, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}
