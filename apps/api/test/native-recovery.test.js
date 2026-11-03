import { afterAll, beforeAll, expect, test } from "bun:test";
import { callAvailability } from "../src/domains/availability/sources.js";
import {
  startHarness,
  createUser,
  nativeSignIn,
} from "./harness.js";
import { sha256Hex } from "../src/core/util.js";

/** @type {import('./harness.js').Harness} */
let h;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

test("legacy seeded call identifier does not crash the availability reader", async () => {
  // Same persisted text shape as execution.js, and the exact observed log value.
  // No matching checklist/audit means unknown, not a fabricated perfect score.
  const result = await callAvailability(h.db, {
    id: crypto.randomUUID(),
    outlet_id: crypto.randomUUID(),
    assignee_profile_id: crypto.randomUUID(),
    client_visit_id: "sample:0-2026-10-20-24",
    checked_in_at: new Date("2026-10-20T00:00:00Z"),
  });
  expect(result).toBeNull();
});

/** @param {string} clientVisitId */
async function availabilityFixture(clientVisitId) {
  const unit = crypto.randomUUID();
  const person = crypto.randomUUID();
  const outlet = crypto.randomUUID();
  const snapshot = crypto.randomUUID();
  const email = `${person}@example.com`;
  const user = await createUser(h, email, "isolated fixture password");
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride',${unit},'Test team','national','active','2026-10-01')`;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${person},${user},${user},'Test rep',${email},'sales','active',${unit})`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,classification,enrolment_status,created_by) values(${outlet},'sunpride',${outlet},'Test store','active',${unit},'GT','A','approved','fixture')`;
  const [visit] = await h.db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,intents,state,productivity,last_server_time,checked_in_at) values('sunpride',${clientVisitId},${person},${outlet},${unit},'2026-10-20','unplanned',array['merchandise'],'checked-in','pending','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z') returning *`;
  const [legacy] = await h.db`insert into merchandising_audits(organization_id,org_unit_id,client_audit_id,visit_id,outlet_id,assignee_profile_id,service_date,device_time,server_time,payload_hash,audit_version,required_count,required_available_count,required_out_of_stock_count,actor_subject,source) values('sunpride',${unit},${crypto.randomUUID()},${visit.id},${outlet},${person},'2026-10-20','2026-10-20T00:01:00Z','2026-10-20T00:01:00Z','fixture','1',2,1,1,'fixture','web') returning id`;
  await h.db`insert into availability_call_snapshots(id,outlet_id,profile_id,app,service_date,content_hash,body) values(${snapshot},${outlet},${person},'field-android','2026-10-20','fixture',${{}})`;
  return { visit, snapshot, legacy };
}

/** @param {Awaited<ReturnType<typeof availabilityFixture>>} f
 * @param {boolean} complete @param {string} deviceTime */
async function canonicalCheck(f, complete, deviceTime) {
  const id = crypto.randomUUID();
  const v = f.visit;
  await h.db`insert into availability_checks(id,snapshot_id,outlet_id,profile_id,org_unit_id,visit_id,call_key,service_date,device_time,complete,required_count,checked_count,present_count,lines,proposals,payload_hash,actor_subject)
    values(${id},${f.snapshot},${v.outlet_id},${v.assignee_profile_id},${v.org_unit_id},${v.id},${v.client_visit_id},'2026-10-20',${deviceTime},${complete},2,${complete ? 2 : 1},${complete ? 2 : 1},${[]},${[]},'fixture','fixture')`;
  return id;
}

/** @param {Awaited<ReturnType<typeof availabilityFixture>>} f */
function legacyScore(f) {
  return { score: 50, sourceId: f.legacy.id, definitionVersion: "legacy-merchandising/v1" };
}

test("persisted legacy identifier retains matching merchandising audit fallback", async () => {
  const f = await availabilityFixture("sample:0-2026-10-20-24");
  expect(await callAvailability(h.db, f.visit)).toEqual(legacyScore(f));
  expect(await callAvailability(h.db, { ...f.visit, id: crypto.randomUUID() })).toBeNull();
});

test("valid UUID uses canonical checklist ahead of matching legacy audit", async () => {
  const f = await availabilityFixture(crypto.randomUUID());
  expect(await callAvailability(h.db, f.visit)).toEqual(legacyScore(f));
  const sourceId = await canonicalCheck(f, true, "2026-10-20T00:02:00Z");
  expect(await callAvailability(h.db, f.visit)).toEqual({
    score: 100, sourceId, definitionVersion: "availability/2026-10-v1",
  });
});

test("latest incomplete canonical checklist suppresses older canonical and legacy scores", async () => {
  const f = await availabilityFixture(crypto.randomUUID());
  await canonicalCheck(f, true, "2026-10-20T00:02:00Z");
  await canonicalCheck(f, false, "2026-10-20T00:03:00Z");
  expect(await callAvailability(h.db, f.visit)).toBeNull();
});

test("canonical lookup retains outlet, profile, call and check-in boundaries", async () => {
  const f = await availabilityFixture(crypto.randomUUID());
  await canonicalCheck(f, true, "2026-10-20T00:02:00Z");
  for (const mismatch of [
    { outlet_id: crypto.randomUUID() },
    { assignee_profile_id: crypto.randomUUID() },
    { client_visit_id: crypto.randomUUID() },
    { checked_in_at: new Date("2026-10-20T00:03:00Z") },
  ]) {
    // Keep visit.id to prove only the incompatible canonical row is ignored.
    expect(await callAvailability(h.db, { ...f.visit, ...mismatch })).toEqual(legacyScore(f));
  }
});

test("expired native session refuses refresh without issuing access", async () => {
  const email = "native-recovery@example.com";
  const password = "isolated test password";
  const userId = await createUser(h, email, password);
  const signed = await nativeSignIn(h, email, password, "field-ios");
  expect(signed.res.status).toBe(200);
  await h.db`update sessions set expires_at=now()-interval '1 second' where user_id=${userId}`;
  const [before] = await h.db`select count(*)::int n from access_tokens`;
  const res = await h.fetch("/api/auth/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signed.body.sessionToken}`,
    },
    body: JSON.stringify({ version: 2, app: "field-ios" }),
  });
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.error.code).toBe("session_invalid");
  expect(body.error.action).toBe("reauthenticate");
  const [after] = await h.db`select count(*)::int n from access_tokens`;
  expect(after.n).toBe(before.n);
  const [session] = await h.db`select expires_at < now() as expired from sessions where token_hash=${sha256Hex(signed.body.sessionToken)}`;
  expect(session.expired).toBe(true);
});
