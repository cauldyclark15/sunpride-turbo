import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { runOutbox } from "../src/domains/integration/outbox.js";
import { readEligibilityFacts } from "../src/domains/integration/spec-adapters.js";
import { seams } from "../src/domains/retail/common.js";
import { enforcePartnerOp } from "../src/domains/partners/boundary.js";
import { manilaDate } from "../src/domains/visits/shared.js";

/** @type {any} */ let h;
/** @type {any} */ let mock;
/** @type {any} */ let actor;
const id = () => crypto.randomUUID(),
  unit = id(),
  outlet = id(),
  visit = id(),
  person = id(),
  partner = id(),
  action = id(),
  audit = id(),
  geo = id();
const early = new Date(Date.now() - 86400000);
beforeAll(async () => {
  h = await startHarness();
  mock = startMock({ path: h.filesDir + "/sap.sqlite", port: 0 });
  h.env.SAP_MODE = "mock";
  h.env.SAP_ORIGIN = mock.origin;
  const user = await createUser(
    h,
    "finish-b-retail@example.com",
    "Test-fixture-only-512!",
  );
  actor = {
    userId: user,
    subject: user,
    profileId: person,
    role: "sales",
    orgUnitId: unit,
  };
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','Sample team','national','active',${early})`;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${person},${user},${user},'Sample agency rep','finish-b-retail@example.com','sales','active',${unit})`;
  await h.db`insert into distributors(id,code,name,org_unit_id,status,source,partner_kind,effective_from) values(${partner},'SAMPLE-B','Sample agency',${unit},'accredited','sample','agency',${early})`;
  await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${partner},${person},array['field'],${early})`;
  await h.db`insert into master_definitions(id,kind,code,org_unit_id) values(${geo},'geography','SAMPLE-B',${unit})`;
  await h.db`insert into master_versions(master_id,version,label,status,data,effective_from,reason) values(${geo},1,'Sample area','active',${{}},${early},'Sample fixture')`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,geography_id,classification,created_by) values(${outlet},'sunpride','SAMPLE-B','Sample store','active',${unit},${geo},'A','fixture')`;
  await h.db`insert into partner_outlet_assignments(distributor_id,outlet_id,effective_from) values(${partner},${outlet},${early})`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('finish-b-fixture','outlets',${outlet},'sample-store')`;
  await h.db`insert into visit_executions(id,organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,intents,state,productivity,last_server_time,checked_in_at,started_at) values(${visit},'sunpride',${id()},${person},${outlet},${unit},${manilaDate(Date.now())},'unplanned',array['merchandise'],'checked-in','pending',now(),${early},${early})`;
  await h.db`insert into retail_execution_audits(id,visit_id,outlet_id,profile_id,org_unit_id,kind,request_key,payload_hash,captured_at,facts,actor_subject) values(${audit},${visit},${outlet},${person},${unit},'expiry',${id()},'fixture',${early},${{ lines: [] }},${user})`;
  await h.db`insert into retail_action_cases(id,audit_id,outlet_id,kind,status,due_at,facts) values(${action},${audit},${outlet},'pullout','awaiting_sap',now(),${{ batch: "Sample expiry" }})`;
});
afterAll(async () => {
  mock?.stop();
  await h?.close();
});

test("F-318 canonical geography and class facts resolve restricted campaign eligibility", async () => {
  const facts = await readEligibilityFacts(
    { db: h.db },
    { outletId: outlet, at: Date.now() },
  );
  expect(facts.classKey).toBe("A");
  expect(facts.geographyKey).toBe(geo);
  expect(
    seams.campaignEligible({ geographyKey: { include: [geo] } }, facts),
  ).toBe(true);
});
test("F-319 F-322 agency can submit canonical retail and availability but not commercial proposals", async () => {
  for (const opType of ["retail.capture", "availability.record"])
    await tx(h.db, (db) =>
      enforcePartnerOp(db, actor, {
        opType,
        clientTime: Date.now(),
        payload: { visitId: visit, deviceTime: Date.now() },
      }),
    );
  await expect(
    enforcePartnerOp(h.db, actor, {
      opType: "availability.proposal",
      payload: {},
    }),
  ).rejects.toThrow("not enabled");
  await expect(
    enforcePartnerOp(h.db, actor, {
      opType: "retail.capture",
      payload: { visitId: id() },
    }),
  ).rejects.toThrow("Not your visit");
});
test("F-320 approved shelf instruction reaches actual mock SAP and becomes resolvable once", async () => {
  const result = await tx(h.db, (db) =>
    seams.requestSapAction({ db, env: h.env }, { caseId: action }),
  );
  expect(result.status).toBe("queued");
  await runOutbox(h.db, { env: h.env });
  const [saved] =
    await h.db`select status from retail_action_cases where id=${action}`;
  expect(saved.status).toBe("approved");
  const [events] =
    await h.db`select count(*)::int n from retail_case_events where case_id=${action} and kind='sap.acknowledged'`;
  expect(events.n).toBe(1);
  const replay = await tx(h.db, (db) =>
    seams.requestSapAction({ db, env: h.env }, { caseId: action }),
  );
  expect(replay.postingId).toBe(result.postingId);
  expect(replay.status).toBe("acknowledged");
});
test("F-322 withdrawn membership still refuses new retail captures", async () => {
  await h.db`update distributor_users set effective_to=now() where distributor_id=${partner}`;
  await expect(
    enforcePartnerOp(h.db, actor, {
      opType: "retail.capture",
      payload: { visitId: visit },
    }),
  ).rejects.toThrow("access has ended");
});
