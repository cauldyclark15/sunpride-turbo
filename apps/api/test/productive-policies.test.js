import { beforeAll, afterAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import {
  installProductivePolicies,
  productivePolicyCommand,
  productivePolicies,
  snapshotProductivePolicy,
} from "../src/domains/visits/productive-policies.js";
import { isProductive } from "../src/domains/visits/productive.js";
import { visitSummary } from "../src/domains/analytics/data.js";
/** @type {any} */ let h;
/** @type {any} */ let platform;
/** @type {any} */ let author;
/** @type {any} */ let approver;
/** @type {any} */ let rep;
/** @type {any} */ let foreign;
/** @type {any} */ let published;
const now = Date.parse("2026-10-20T04:00:00Z");
/** @param {string} name @param {string} role @param {string} unit */
async function person(name, role, unit) {
  const [u] =
    await h.db`insert into users(email,password_hash) values (${name + "@productive.test"},'unused') returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,name,email,role,status,org_unit_id) values (${u.id},${name},${name + "@productive.test"},${role},'active',${unit}) returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values (${p.id},${unit},${role},'2020-01-01',${u.id},'F-208 fixture')`;
  return p;
}
/** @param {any} p @param {number} [at] */
const ctx = (p, at = now - 86400000) => ({
  db: h.db,
  now: at,
  actor: {
    profileId: p.id,
    userId: p.user_id,
    subject: p.user_id,
    role: p.role,
    orgUnitId: p.org_unit_id,
  },
});
/** @param {any} who @param {string} action @param {any} body */
const run = (who, action, body) =>
  productivePolicyCommand(ctx(who), platform, action, {
    idempotencyKey: crypto.randomUUID(),
    ...body,
  });
const definition = {
  rule: "any_listed_activity",
  matchMode: "any",
  requiresPlanned: true,
  allowedCodes: ["collection"],
};
beforeAll(async () => {
  h = await startHarness({
    installers: [
      (/** @type {any} */ r, /** @type {any} */ p) => {
        platform = p;
        installProductivePolicies(r, p);
      },
    ],
  });
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','PROD','Productive team','region','active','2020-01-01') returning id`;
  const [other] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','OTHER','Other team','region','active','2020-01-01') returning id`;
  author = await person("author", "admin", unit.id);
  approver = await person("approver", "manager", unit.id);
  rep = await person("rep", "sales", unit.id);
  foreign = await person("foreign", "manager", other.id);
});
afterAll(async () => {
  await h?.close();
});
test("F-208 definitions require independent publication; snapshot records applicability, approval, version and hash", async () => {
  expect((await productivePolicies(ctx(author))).policies).toHaveLength(0);
  const draft = await run(author, "draft", {
    orgUnitId: author.org_unit_id,
    label: "SAMPLE collections objective",
    sourceRef: "SAMPLE Sales/Trade Marketing agreement",
    fromDate: "2026-10-20",
    definition,
  });
  expect(draft.status).toBe("draft");
  expect((await snapshotProductivePolicy(h.db, rep.id, now)).source).toBe(
    "provisional",
  );
  await expect(
    run(author, "publish", { policyId: draft._id }),
  ).rejects.toThrow();
  await expect(
    run(foreign, "publish", { policyId: draft._id }),
  ).rejects.toThrow();
  published = await run(approver, "publish", { policyId: draft._id });
  expect(published.status).toBe("published");
  const snapshot = await snapshotProductivePolicy(h.db, rep.id, now);
  expect(snapshot.policyId).toBe(draft._id);
  expect(snapshot.version).toBe(1);
  expect(snapshot.approvedBy).toBe("approver");
  expect(snapshot.contentHash).toHaveLength(64);
  expect(snapshot.effectiveFrom).toBe(Date.parse("2026-10-20T00:00:00+08:00"));
  expect(
    (await snapshotProductivePolicy(h.db, rep.id, now - 86400000 - 1)).source,
  ).toBe("provisional");
});
test("F-208 replacements are prospective, overlap refuses atomically, and old visit snapshots stay authoritative", async () => {
  const frozen = await snapshotProductivePolicy(h.db, rep.id, now),
    newDef = { ...definition, allowedCodes: ["merchandising"] };
  const overlap = await run(author, "draft", {
    orgUnitId: author.org_unit_id,
    label: "Bad overlap",
    sourceRef: "SAMPLE",
    fromDate: "2026-10-20",
    definition: newDef,
  });
  await expect(
    run(approver, "publish", { policyId: overlap._id }),
  ).rejects.toThrow("Another published");
  const next = await run(author, "draft", {
    orgUnitId: author.org_unit_id,
    label: "Next objective",
    sourceRef: "SAMPLE",
    fromDate: "2026-10-21",
    replacesPolicyId: published._id,
    definition: newDef,
  });
  await run(approver, "publish", { policyId: next._id });
  const tomorrow = await snapshotProductivePolicy(h.db, rep.id, now + 86400000);
  expect(tomorrow.version).toBe(2);
  const facts = {
    inRoutePlan: true,
    state: "checked-out",
    activityKinds: ["merchandising"],
  };
  expect(
    isProductive({ ...facts, productivePolicySnapshot: frozen }, {}).productive,
  ).toBe(false);
  expect(
    isProductive({ ...facts, productivePolicySnapshot: tomorrow }, {})
      .productive,
  ).toBe(true);
  expect((await snapshotProductivePolicy(h.db, rep.id, now)).version).toBe(1);
  const [old] =
    await h.db`select effective_to from productive_call_policies where id=${published._id}`;
  expect(+new Date(old.effective_to)).toBe(
    Date.parse("2026-10-21T00:00:00+08:00"),
  );
});
test("F-208 idempotency reauthorizes before replay and policy content tampering fails closed", async () => {
  const key = crypto.randomUUID(),
    body = {
      idempotencyKey: key,
      orgUnitId: author.org_unit_id,
      label: "Future",
      sourceRef: "SAMPLE",
      fromDate: "2026-12-01",
      definition,
    };
  const a = await run(author, "draft", body);
  expect((await run(author, "draft", body))._id).toBe(a._id);
  await expect(
    run(author, "draft", { ...body, label: "Changed" }),
  ).rejects.toThrow("different policy");
  await h.db`update profiles set status='disabled' where id=${author.id}`;
  await expect(run(author, "draft", body)).rejects.toThrow("no longer active");
  await h.db`update profiles set status='active' where id=${author.id}`;
  await h.db`update productive_call_policies set definition=definition||${{ allowedCodes: ["purchase_order"] }}::jsonb where id=${published._id}`;
  await expect(snapshotProductivePolicy(h.db, rep.id, now)).rejects.toThrow(
    "definition changed",
  );
});
test("F-208 one pure evaluator distinguishes qualified calls, order strike rate, unknown and all-required definitions", () => {
  const p = { ...definition, source: "published" },
    base = { inRoutePlan: true, state: "completed" };
  expect(
    isProductive(
      { ...base, activityKinds: ["note"], productivePolicySnapshot: p },
      {},
    ).productive,
  ).toBe(false);
  expect(
    isProductive(
      { ...base, collectionCount: 1, productivePolicySnapshot: p },
      {},
    ).productive,
  ).toBe(true);
  expect(
    isProductive(
      {
        ...base,
        collectionCount: 1,
        outcome: "nonproductive",
        productivePolicySnapshot: p,
      },
      {},
    ).productive,
  ).toBe(false);
  expect(
    isProductive(
      {
        ...base,
        collectionCount: 1,
        productivePolicySnapshot: { ...p, matchMode: "future" },
      },
      {},
    ).reason,
  ).toBe("policy_unknown");
  const all = {
    ...p,
    allowedCodes: ["collection", "merchandising"],
    matchMode: "all",
  };
  expect(
    isProductive(
      { ...base, collectionCount: 1, productivePolicySnapshot: all },
      {},
    ).productive,
  ).toBe(false);
  expect(
    isProductive(
      {
        ...base,
        collectionCount: 1,
        activityKinds: ["merchandising"],
        productivePolicySnapshot: all,
      },
      {},
    ).productive,
  ).toBe(true);
  const summary = visitSummary({
    planned: [{ id: "a" }, { id: "b" }],
    coaching: [],
    visits: [
      {
        call: true,
        service_date: "2026-10-20",
        assignee_profile_id: rep.id,
        onPlan: true,
        productive: true,
        planned_visit_id: "a",
        linked_order_count: 0,
      },
      {
        call: true,
        service_date: "2026-10-20",
        assignee_profile_id: rep.id,
        onPlan: true,
        productive: true,
        planned_visit_id: "b",
        linked_order_count: 1,
      },
    ],
  });
  expect(summary.productiveRate).toBe(100);
  expect(summary.strikeRate).toBe(50);
  expect(summary.orderCalls).toBe(1);
});
test("F-208 malformed identifiers and unsupported applicability never become broad default definitions", async () => {
  const body = {
    orgUnitId: author.org_unit_id,
    label: "Bad payload",
    sourceRef: "TEST",
    fromDate: "2027-01-01",
    definition,
  };
  const [{ n: before }] =
    await h.db`select count(*)::int n from productive_call_policies`;
  for (const invalid of [
    { positionId: 0 },
    { positionId: "" },
    { replacesPolicyId: 0 },
    { replacesPolicyId: "bad-id" },
    { channelKey: "gt" },
    { toDate: 0 },
  ])
    await expect(
      run(author, "draft", { ...body, ...invalid }),
    ).rejects.toThrow();
  const [{ n: after }] =
    await h.db`select count(*)::int n from productive_call_policies`;
  expect(after).toBe(before);
});
test("F-208 additive sample policies are marked, hash-valid and idempotent without creating client agreements", async () => {
  const db = h.db,
    [unit] =
      await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','SAMPLE-PROD','Sample team','region','active','2020-01-01') returning id`;
  const a = await person("sample-author", "admin", unit.id),
    b = await person("sample-approver", "manager", unit.id),
    r = await person("sample-rep", "sales", unit.id);
  const [position] =
    await db`insert into positions(organization_id,code,label,category,active) values ('sunpride','SAMPLE-PROD','Sample role','field',true) returning id`;
  await db`update profiles set position_id=${position.id} where id=${r.id}`;
  await db`update employee_assignments set position_id=${position.id} where profile_id=${r.id}`;
  for (const p of [a, b, r])
    await db`insert into sample_data_rows(batch,table_name,row_id,key) values ('sunpride-demo-v2','profiles',${p.id},${"sample-profile:" + p.id})`;
  const { seedProductiveSpec } =
    await import("../../../packages/db/seed/productive-spec.js");
  expect(await seedProductiveSpec(db, "2026-10-20")).toEqual({
    policies: 1,
    orderLinks: 0,
  });
  expect(await seedProductiveSpec(db, "2026-10-20")).toEqual({
    policies: 0,
    orderLinks: 0,
  });
  const snapshot = await snapshotProductivePolicy(db, r.id, Date.now() + 1000);
  expect(snapshot.source).toBe("published");
  expect(snapshot.label).toContain("not client-agreed");
  expect(snapshot.sourceRef).toContain("SAMPLE");
  const [{ n }] =
    await db`select count(*)::int n from sample_data_rows where table_name='productive_call_policies'`;
  expect(n).toBe(1);
  const [outlet] =
    await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride','LINK','Sample linked store','active',${unit.id},${a.user_id}) returning id`;
  const [visit] =
    await db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time,unplanned_reason) values ('sunpride',${crypto.randomUUID()},${r.id},${outlet.id},${unit.id},'2026-10-20','unplanned','completed','pending',now(),'F-208 fixture') returning id`;
  const clientId = crypto.randomUUID();
  const [activity] =
    await db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values ('sunpride',${unit.id},${visit.id},${r.id},${outlet.id},'order_intent',${{ clientOrderId: clientId, lines: [] }},now(),now()) returning id`;
  let duplicateRefused = false;
  try {
    await db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values ('sunpride',${unit.id},${visit.id},${r.id},${outlet.id},'order_intent',${{ clientOrderId: clientId, lines: [] }},now(),now())`;
  } catch (error) {
    duplicateRefused = /** @type {any} */ (error).errno === "23505";
  }
  expect(duplicateRefused).toBe(true);
  await db`insert into customers(code,name,channel,territory,credit_limit,active) values ('TEST','Sample customer','GT','F208',0,true)`;
  const [order] =
    await db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,status,subtotal,total) values ('sunpride',${clientId},'F208-LINK','TEST',${r.user_id},${r.id},${r.user_id},${unit.id},${outlet.id},'approved',0,0) returning id`;
  await db`insert into sample_data_rows(batch,table_name,row_id,key) values ('sunpride-demo-v2','orders',${order.id},${order.id})`;
  expect(await seedProductiveSpec(db, "2026-10-20")).toEqual({
    policies: 0,
    orderLinks: 0,
  });
  expect(
    (await db`select source_activity_id from orders where id=${order.id}`)[0]
      .source_activity_id,
  ).toBeNull();
  await db`insert into sample_data_rows(batch,table_name,row_id,key) values ('sunpride-demo-v2','visit_activities',${activity.id},${activity.id})`;
  await db`update orders set created_by_subject='foreign' where id=${order.id}`;
  expect(await seedProductiveSpec(db, "2026-10-20")).toEqual({
    policies: 0,
    orderLinks: 0,
  });
  await db`update orders set created_by_subject=${r.user_id} where id=${order.id}`;
  expect(await seedProductiveSpec(db, "2026-10-20")).toEqual({
    policies: 0,
    orderLinks: 1,
  });
  expect(
    (await db`select source_activity_id from orders where id=${order.id}`)[0]
      .source_activity_id,
  ).toBe(activity.id);
  expect(await seedProductiveSpec(db, "2026-10-20")).toEqual({
    policies: 0,
    orderLinks: 0,
  });
});
