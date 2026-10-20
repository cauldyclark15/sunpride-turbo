import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import {
  callAvailability,
  availabilitySources,
} from "../src/domains/availability/sources.js";
import { availabilityModel } from "../src/domains/analytics/availability-adapter.js";
import { seams } from "../src/domains/retail/common.js";
import { manilaDate } from "../src/domains/visits/shared.js";

/** @type {any} */ let h;
const id = () => crypto.randomUUID();
const unit = id(),
  person = id(),
  outlet = id(),
  product = id(),
  visit = id(),
  call = id(),
  snapshot = id();
const now = Date.now(),
  day = manilaDate(now),
  early = new Date(now - 86400000);
const execution = {
  id: visit,
  outlet_id: outlet,
  assignee_profile_id: person,
  client_visit_id: call,
  checked_in_at: early,
};
/** @type {any} */ const scope = { ids: [unit], ownProfileId: null };
beforeAll(async () => {
  h = await startHarness();
  const user = await createUser(
    h,
    "finish-b@example.com",
    "Test-fixture-only-094!",
  );
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','Sample team','national','active',${early})`;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${person},${user},${user},'Sample rep','finish-b@example.com','sales','active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${person},${unit},'sales',${early},'fixture','Sample assignment')`;
  await h.db`insert into products(id,code,name,category,uom,unit_price,active,organization_id) values(${product},'SAMPLE-B','Sample SKU','Sample','PC',0,true,'sunpride')`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,classification,enrolment_status,created_by) values(${outlet},'sunpride','SAMPLE-B','Sample store','active',${unit},'GT','A','approved','fixture')`;
  await h.db`insert into visit_executions(id,organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,intents,state,productivity,last_server_time,checked_in_at) values(${visit},'sunpride',${call},${person},${outlet},${unit},${day},'unplanned',array['merchandise'],'checked-in','pending',now(),${early})`;
  await h.db`insert into availability_call_snapshots(id,outlet_id,profile_id,app,service_date,content_hash,body) values(${snapshot},${outlet},${person},'field-android',${day},'fixture',${{}})`;
  const master = id();
  await h.db`insert into master_definitions(id,kind,code) values(${master},'msl','SAMPLE-B')`;
  await h.db`insert into master_versions(master_id,version,label,status,data,effective_from,reason) values(${master},1,'Sample MSL','active',${{ outletClass: "A", productIds: [product] }},${early},'Sample fixture')`;
  await h.db`insert into availability_releases(kind,policy_key,version,label,status,effective_from,payload,source_ref,sample,actor_subject) values('rules','sample-b',1,'Sample rules','published',${early},${{ freshnessDays: 7, coverDays: 7, universeFreshnessDays: 7 }},'Sample fixture',false,'fixture')`;
});
afterAll(async () => {
  await h?.close();
});
/** @param {string} state @param {number} offset */
async function check(state, offset) {
  const checkId = id(),
    checked = state === "not_checked" ? 0 : 1;
  const line = {
    productId: product,
    state,
    shelfBase: state === "absent" ? 0 : null,
    backroomBase: state === "absent" ? 3 : null,
  };
  await h.db`insert into availability_checks(id,snapshot_id,outlet_id,profile_id,org_unit_id,visit_id,call_key,service_date,device_time,complete,required_count,checked_count,present_count,lines,proposals,payload_hash,actor_subject)
    values(${checkId},${snapshot},${outlet},${person},${unit},${visit},${call},${day},${new Date(now + offset)},${checked === 1},1,${checked},${state === "present" ? 1 : 0},${[line]},${[]},${checkId},'fixture')`;
  return checkId;
}
test("F-211 F-214 F-316 F-602 canonical shelf absence with back-room stock reconciles scoring and tower", async () => {
  const sourceId = await check("absent", -2000);
  const score = await seams.availability({ db: h.db }, execution);
  expect(score?.score).toBe(0);
  expect(score?.sourceId).toBe(sourceId);
  const model = await availabilityModel(
    h.db,
    { from: day, to: day, channel: null },
    { ...scope },
  );
  expect(model.setupRequired).toBe(false);
  expect(model.required).toBe(1);
  expect(model.checked).toBe(1);
  expect(model.osa).toBe(0);
  expect(model.distribution[0].numericDistributionPct).toBe(100);
  expect(model.observations[0].sourceId).toBe(sourceId);
});
test("F-212 F-316 F-602 explicit unknown supersedes old check and cannot revive legacy perfection", async () => {
  await check("not_checked", -1000);
  expect(await callAvailability(h.db, execution)).toBeNull();
  const sources = await availabilitySources(
    h.db,
    { to: day },
    scope,
    [{ id: outlet, owner_unit_id: unit }],
    [],
    [],
    [{ outlet_id: outlet, product_id: product, status: "available" }],
  );
  expect(sources.observations[0].status).toBe("not_checked");
  const model = await availabilityModel(
    h.db,
    { from: day, to: day, channel: null },
    { ...scope },
  );
  expect(model.checked).toBe(0);
  expect(model.osa).toBeNull();
  expect(model.distribution[0].numericDistributionPct).toBeNull();
});
