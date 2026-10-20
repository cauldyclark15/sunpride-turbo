import { test, expect, beforeAll, afterAll } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { sha256Hex } from "../src/core/util.js";
import { addDays } from "../src/domains/analytics/measures.js";
const { install: analytics } =
  await import("../src/domains/analytics/index.js");
const { installDormancy, detectDormancy } =
  await import("../src/domains/coverage/dormancy.js");

/** @type {any} */ let h;
/** @type {any} */ let f;
/** @type {any} */ let otherManager;
beforeAll(async () => {
  h = await startHarness({
    installers: [
      analytics,
      (/** @type {any} */ router, /** @type {any} */ platform) =>
        installDormancy(router, platform),
    ],
  });
  f = await analyticsFixture(h);
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${f.boss},${f.root},'super_admin','2020-01-01','fixture','fixture')`;
  // A manager of Team B: in-role, but the dormant Team A store is outside their persisted scope.
  const [u] =
    await h.db`insert into users(email,password_hash) values('manager-b@example.com','not-a-password-hash') returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},'Manager B','manager-b@example.com','manager','active',${f.b}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${f.b},'manager','2020-01-01','fixture','fixture')`;
  await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex("sps_manager_b")},'web',now()+interval '1 day')`;
  otherManager = "sp_session=sps_manager_b";
}, 120000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} path @param {any} [body] @param {string} [cookie] */
async function call(path, body, cookie = f.cookie) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** Move a store's whole purchase history back in time. @param {string} code @param {number} days */
async function lastBought(code, days) {
  await h.db`update orders set created_at=created_at-make_interval(days=>${days}),offline_created_at=null where customer_code=${"C" + code.slice(1)}`;
}
const store = async (/** @type {string} */ code) =>
  (await h.db`select id from outlets where code=${code}`)[0].id;

test("F-210 cycle-based detection uses class frequency, then outlet cadence, then policy fallback; never-buying stores are excluded", async () => {
  expect(
    (
      await call("/api/v1/coverage/dormancy/policy", {
        orgUnitId: f.root,
        label: "TEST dormancy rule",
        sourceRef: "TEST assumption",
        missedCycles: 3,
        fallbackCycleDays: 30,
        fromDate: addDays(f.today, -1),
      })
    ).status,
  ).toBe(400);
  const saved = await call("/api/v1/coverage/dormancy/policy", {
    orgUnitId: f.root,
    label: "TEST dormancy rule",
    sourceRef: "TEST assumption",
    missedCycles: 3,
    fallbackCycleDays: 30,
    fromDate: f.today,
  });
  expect(saved.status).toBe(200);
  // Policies start at Manila midnight, so detection at 'now' is inside the interval.
  // S1: outlet cadence 14 days, 70 days quiet -> 5 cycles -> dormant.
  await h.db`update outlets set visit_frequency_days=14 where code='S1'`;
  await lastBought("S1", 70);
  // S2: same cadence, 30 days quiet -> 2 cycles -> not dormant.
  await h.db`update outlets set visit_frequency_days=14 where code='S2'`;
  await lastBought("S2", 30);
  // S3: 70 days quiet, but its class visits every 4 weeks -> 2 cycles -> not dormant.
  await h.db`update outlets set visit_frequency_days=14,classification='TEST-A' where code='S3'`;
  await h.db`insert into outlet_class_visit_policies(org_unit_id,class_key,label,interval_weeks,service_minutes,effective_from,source_ref,created_by) values(${f.root},'TEST-A','TEST class',4,20,'2020-01-01','TEST',${f.boss})`;
  await lastBought("S3", 70);
  // S5: no cadence anywhere, 100 days quiet -> fallback 30 days -> 3 cycles -> dormant.
  await lastBought("S5", 100);
  // S7: never bought -> excluded (a "never" store is not dormancy).
  await h.db`delete from order_lines where order_id in (select id from orders where customer_code='C7')`;
  const first = await detectDormancy(h.db, Date.now());
  expect(first.opened).toBe(2);
  const repeat = await detectDormancy(h.db, Date.now());
  expect(repeat.opened).toBe(0);
  const cases =
    await h.db`select o.code,k.cycle_days,k.cycle_source,k.missed_cycles,k.status from outlet_dormancy_cases k join outlets o on o.id=k.outlet_id order by o.code`;
  expect(
    cases.map((/** @type {any} */ c) => [
      c.code,
      c.cycle_source,
      c.cycle_days,
      c.missed_cycles,
    ]),
  ).toEqual([
    ["S1", "outlet_cadence", 14, 5],
    ["S5", "policy_fallback", 30, 3],
  ]);
});

test("F-210 owner read, Decide item and scoped idempotent owner actions", async () => {
  const read = await call("/api/v1/coverage/dormancy");
  expect(read.status).toBe(200);
  expect(read.body.summary.open).toBe(2);
  expect(read.body.summary.withoutAction).toBe(2);
  const s1 = read.body.cases.find((/** @type {any} */ c) => c.code === "S1");
  expect(s1.cycleSource).toBe("outlet_cadence");
  const decide = await call(
    `/api/v1/analytics/exceptions?from=${f.start}&to=${f.today}&kind=dormant_store`,
  );
  expect(decide.status).toBe(200);
  expect(
    decide.body.items.map((/** @type {any} */ i) => i.subject.label).sort(),
  ).toEqual(["Store 1", "Store 5"]);
  const action = {
    caseId: s1.id,
    kind: "recovery_visit",
    note: "TEST visit with sample offer",
    dueOn: addDays(f.today, 2),
    idempotencyKey: "a1",
  };
  expect(
    (
      await call("/api/v1/coverage/dormancy/action", {
        ...action,
        dueOn: addDays(f.today, -1),
        idempotencyKey: "past",
      })
    ).status,
  ).toBe(400);
  // Store 1 belongs to Team A: a Team B manager holds the role but not the store.
  expect(
    (await call("/api/v1/coverage/dormancy/action", action, otherManager))
      .status,
  ).toBe(403);
  const done = await call("/api/v1/coverage/dormancy/action", action);
  expect(done.status).toBe(200);
  expect((await call("/api/v1/coverage/dormancy/action", action)).body.id).toBe(
    done.body.id,
  );
  expect(
    (
      await call("/api/v1/coverage/dormancy/action", {
        ...action,
        note: "Changed",
      })
    ).status,
  ).toBe(409);
  const after = await call("/api/v1/coverage/dormancy");
  expect(after.body.summary.withoutAction).toBe(1);
  const [{ n }] =
    await h.db`select count(*)::int n from outlet_dormancy_actions where case_id=${s1.id}`;
  expect(n).toBe(1);
});

test("F-210 a new authoritative purchase records recovery; an owner-closed gap is not reopened", async () => {
  const s1 = await store("S1");
  await h.db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,created_at)
    values('fixture','RECOVER-1','RECOVER-1','C1','agent-1','approved',10,10,now())`;
  await h.db`insert into order_lines(order_id,product_code,description,quantity,unit_price,line_total) select id,'P1','Canned meat',1,10,10 from orders where order_number='RECOVER-1'`;
  const r = await detectDormancy(h.db, Date.now());
  expect(r.recovered).toBe(1);
  const [k] =
    await h.db`select status,recovery_purchase_on::text d from outlet_dormancy_cases where outlet_id=${s1}`;
  expect(k.status).toBe("recovered");
  expect(k.d).toBe(f.today);
  const read = await call("/api/v1/coverage/dormancy");
  const s5 = read.body.cases.find((/** @type {any} */ c) => c.code === "S5");
  expect(
    (
      await call("/api/v1/coverage/dormancy/action", {
        caseId: s5.id,
        kind: "close",
        note: "TEST store closed its doors",
        idempotencyKey: "close-5",
      })
    ).status,
  ).toBe(200);
  expect((await detectDormancy(h.db, Date.now())).opened).toBe(0);
  const statuses =
    await h.db`select status from outlet_dormancy_cases where outlet_id=${await store("S5")} order by created_at`;
  expect(statuses.map((/** @type {any} */ x) => x.status)).toEqual(["closed"]);
  expect(
    (
      await call("/api/v1/coverage/dormancy/action", {
        caseId: s5.id,
        kind: "owner_review",
        note: "late",
        idempotencyKey: "late",
      })
    ).status,
  ).toBe(409);
});
