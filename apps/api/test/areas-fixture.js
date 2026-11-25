// Minimal, explicitly invented map explorer facts. Only used by isolated tests/proof.
import { sha256Hex } from "../src/core/util.js";
import { manilaDate } from "../src/domains/fieldsync/model.js";

/** @param {any} connection */
export async function mapFixture(connection) {
  return connection.begin(async (/** @type {any} */ db) => {
    const date = manilaDate(Date.now());
    const [root] =
      await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','Sample national office','national','active','2026-01-01') returning id`;
    const [unit] =
      await db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','MAP-CEBU','Sample Cebu branch','region',${root.id},'active','2026-01-01') returning id`;
    const [foreign] =
      await db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','MAP-MANILA','Sample Manila branch','region',${root.id},'active','2026-01-01') returning id`;
    const password = crypto.randomUUID() + crypto.randomUUID();
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    /** @param {string} role @param {string} name @param {string} org */
    async function person(role, name, org) {
      const email = `map-${role}@sp254.test`;
      const [u] =
        await db`insert into users(email,password_hash) values(${email},${hash}) returning id`;
      const [p] =
        await db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},${name},${email},${role},'active',${org}) returning *`;
      const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
      await db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
      return { ...p, cookie: `sp_session=${token}`, password };
    }
    const admin = await person("admin", "Sample office admin", root.id);
    const sales = await person("sales", "Sample Cebu salesman", unit.id);
    const viewer = await person(
      "viewer",
      "Sample read-only viewer",
      foreign.id,
    );
    const [location] =
      await db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride',${foreign.id},'MAP','MAP-FOREIGN','Sample foreign warehouse','warehouse',true,true,true,true,false) returning id`;
    const [plan] =
      await db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,approval_signature,content_hash,content_revision,created_by,updated_by)
    values('sunpride',${sales.id},${date.slice(0, 7)},1,'monthly',${unit.id},${date}::date,${date}::date+1,${date}::date,${date}::date+1,'active','sample:SP-0254',now(),'sample:SP-0254','sample',1,'sample:SP-0254','sample:SP-0254') returning id`;
    /** @type {any[]} */ const stores = [];
    const cityCodes = [
      "0730600000",
      "0731300000",
      "0731100000",
      "1381300000",
      null,
    ];
    for (let i = 0; i < 5; i++) {
      const code = `MAP-SAMPLE-${i + 1}`;
      const org = i === 3 ? foreign.id : unit.id;
      const [o] =
        await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride',${code},${`Sample map store ${i + 1}`},'active',${org},'sample:SP-0254') returning id`;
      stores.push(o.id);
      await db`insert into customers(code,name,channel,territory,credit_limit,active) values(${code},${`Sample map store ${i + 1}`},'GT','Sample',0,true)`;
      const [m] = cityCodes[i]
        ? await db`select * from ph_municipalities where code=${cityCodes[i]}`
        : [];
      await db`insert into customer_profiles(outlet_id,region_code,province_code,municipality_code,source,updated_by) values(${o.id},${m?.region_code ?? null},${m?.province_code ?? null},${m?.code ?? null},'sample:SP-0254','sample:SP-0254')`;
      const amount = i === 3 ? 400000 : (i + 1) * 10000;
      await db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,salesperson_profile_id,outlet_id,org_unit_id,status,subtotal,total,service_date,total_centavos,amount_known)
      values('sunpride',${crypto.randomUUID()},${code},${code},${sales.auth_subject},${sales.id},${o.id},${org},'approved',${amount / 100},${amount / 100},${date},${amount},true)`;
      if (i < 4) {
        const snapshot = {
          outletId: o.id,
          outletName: `Sample map store ${i + 1}`,
          outletCode: code,
        };
        const [slot] =
          await db`insert into coverage_plan_slots(slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,sequence,expected_duration_minutes,approved_snapshot,content_revision,updated_by) values(${code},${plan.id},${sales.id},${date},'outlet_visit',${o.id},array['sell'],${i + 1},20,${snapshot},1,'sample:SP-0254') returning id`;
        await db`insert into planned_visits(generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at) values(${code},${plan.id},1,${slot.id},${sales.id},${o.id},${date},'planned',${snapshot},array['sell'],20,now())`;
      }
      if (i < 3)
        await db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time,checked_in_at,checked_out_at)
      values('sunpride',${crypto.randomUUID()},${sales.id},${o.id},${unit.id},${date},'unplanned','completed','pending',now(),now()-interval '1 hour',now())`;
      if (i < 3)
        await db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,evidence_note) values(${o.id},${[10.3157, 10.33, 10.31][i]},${[123.8854, 123.94, 123.955][i]},100,'sample:SP-0254','verified','2026-01-01','sample:SP-0254',now(),'Invented sample location')`;
    }
    // Same customer and local salesman; foreign source must never enter scoped sales.
    await db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,salesperson_profile_id,outlet_id,org_unit_id,source_location_id,status,subtotal,total,service_date,total_centavos,amount_known)
      values('sunpride',${crypto.randomUUID()},'MAP-FOREIGN-ORDER','MAP-SAMPLE-1',${sales.auth_subject},${sales.id},${stores[0]},${unit.id},${location.id},'approved',900,900,${date},90000,true)`;
    return {
      date,
      root: root.id,
      unit: unit.id,
      foreign: foreign.id,
      admin,
      sales,
      viewer,
      stores,
    };
  });
}
