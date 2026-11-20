import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import {
  install as coverage,
  activateDue,
} from "../src/domains/coverage/index.js";
import { install as sync } from "../src/domains/fieldsync/index.js";
import { install as visits } from "../src/domains/visits/index.js";
import { identityHooks } from "../src/domains/org/identity.js";
import { setHooks } from "../src/core/hooks.js";
import { isProductive } from "../src/domains/visits/productive.js";

/** @type {import("./harness.js").Harness} */ let h;
/** @type {any} */ let unit;
/** @type {any} */ let admin;
/** @type {any} */ let manager;
/** @type {any} */ let seller;
/** @type {any} */ let stranger;
/** @type {any} */ let outlet;
/** @type {any} */ let territory;
/** @type {any} */ let plan;
/** @type {any} */ let routine;
/** @type {any} */ let native;
/** @type {any[]} */ let activities;
const now = Date.parse("2030-11-10T04:00:00Z"),
  day = "2030-11-10",
  tomorrow = "2030-11-11";
const password = "fixture-only-not-a-client-password";
/** @param {string} name @param {string} role @param {string|null} [supervisor] */
async function person(name, role, supervisor = null) {
  const userId = await createUser(h, `${name}@example.test`, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values (${userId},${userId},${name},${`${name}@example.test`},${role},'active',${unit.id}) returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,supervisor_id,effective_from,actor_subject,reason) values (${p.id},${unit.id},${role},${supervisor},'2020-01-01',${userId},'SP-0225 sample fixture')`;
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions(token_hash,user_id,app,expires_at) values (${new Bun.CryptoHasher("sha256").update(token).digest("hex")},${userId},'web',${new Date(now + 86400000)})`;
  return { ...p, cookie: `sp_session=${token}` };
}
/** @param {any} p @param {string} path @param {any} [body] */
async function request(p, path, body) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: p.cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}
/** @param {any} p @param {string} path @param {any} body */
async function post(p, path, body) {
  const r = await request(p, path, body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
}
/** @param {any} p @param {string} path @param {any} body */
const command = (p, path, body) =>
  post(p, `coverage/${path}`, { idempotencyKey: crypto.randomUUID(), ...body });
/** @param {string} date @param {any} work */
const slot = (date, work) => ({
  slotKey: `visit:${date}`,
  serviceDate: date,
  kind: "outlet_visit",
  outletId: outlet.id,
  sequence: 1,
  expectedDurationMinutes: 20,
  requiredObjectives: [],
  intents: [],
  storeWork: work,
});
async function download() {
  return signedPost(h, native, "/api/sync/pull", {
    version: 2,
    app: "field-android",
    deviceId: native.deviceId,
    since: null,
    pageCursor: null,
    scopes: [
      {
        scopeId: unit.id,
        projection: "field.bundle",
        params: { dayFrom: day },
      },
    ],
    limit: 100,
  });
}
/** @param {string} type @param {any} payload */
const op = (type, payload) => ({
  clientOpId: crypto.randomUUID(),
  opType: type,
  clientTime: now,
  dependsOn: [],
  payload,
});
/** @param {any} operation */
async function push(operation) {
  const r = await signedPost(h, native, "/api/sync/push", {
    version: 2,
    app: "field-android",
    deviceId: native.deviceId,
    scopeId: unit.id,
    operations: [operation],
  });
  expect(r.res.status, JSON.stringify(r.body)).toBe(200);
  return r.body.results[0];
}
beforeAll(async () => {
  setSystemTime(new Date(now));
  h = await startHarness({
    installers: [coverage, sync, visits, () => setHooks(identityHooks({}))],
  });
  [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','SUNPRIDE','Sample office','company','active','2020-01-01') returning *`;
  admin = await person("Office225", "super_admin");
  manager = await person("Manager225", "manager");
  seller = await person("Seller225", "sales", manager.id);
  stranger = await person("Other225", "sales", manager.id);
  [territory] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values ('sunpride','T225','Sample territory','active','2020-01-01',${admin.user_id}) returning *`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values (${territory.id},${unit.id},'2020-01-01',${admin.user_id},'Fixture')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,kind,effective_from,actor_subject,reason) values (${territory.id},${seller.id},'primary','2020-01-01',${admin.user_id},'Fixture')`;
  [outlet] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride','O225','Sample corner store','active',${unit.id},${admin.user_id}) returning *`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,sequence,effective_from,actor_subject,reason) values (${outlet.id},${territory.id},1,'2020-01-01',${admin.user_id},'Fixture')`;
  await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at) values (${outlet.id},10.33,123.94,100,'fixture','verified','2020-01-01','first','2020-01-01','second','2020-01-01')`;
}, 30000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    setSystemTime();
  }
});

test("office maintains activities and reusable routines; sellers can read but not change the master list", async () => {
  activities = [];
  for (const name of ["Collection", "Countering", "Count stock"])
    activities.push({
      ...(await post(admin, "store-work/activity", {
        name,
        active: true,
        reason: "Sample meeting examples",
      })),
      name,
    });
  routine = await post(admin, "store-work/routine", {
    name: "Sample follow-up",
    active: true,
    activityIds: activities.slice(0, 2).map((a) => a.id),
    reason: "Reusable sample",
  });
  const catalog = (await request(seller, "store-work/catalog")).data;
  expect(catalog.canManage).toBe(false);
  expect(catalog.activities).toHaveLength(3);
  expect(catalog.routines[0].activityIds).toEqual(
    activities.slice(0, 2).map((a) => a.id),
  );
  expect(
    (
      await request(seller, "store-work/activity", {
        name: "Unauthorized",
        active: true,
        reason: "No",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(admin, "store-work/activity", {
        name: "collection",
        active: true,
        reason: "Duplicate",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await request(admin, "store-work/routine", {
        name: "Bad routine",
        active: true,
        activityIds: [crypto.randomUUID()],
        reason: "Invalid",
      })
    ).status,
  ).toBe(422);
  expect(
    await h.db`select * from audit_logs where action like 'store_work.%'`,
  ).toHaveLength(4);
});

test("routine plus individual selection and tomorrow's different task are signed into dated stops", async () => {
  plan = await command(seller, "plans/create", {
    assigneeProfileId: seller.id,
    localMonth: "2030-11",
  });
  await command(seller, "plans/saveOutlets", {
    planId: plan._id,
    outlets: [
      {
        outletId: outlet.id,
        territoryId: territory.id,
        frequency: "custom",
        preferredWeekdays: [],
        customLocalDates: [day, tomorrow],
        priority: 1,
        expectedDurationMinutes: 20,
        requiredObjectives: [],
      },
    ],
  });
  await command(seller, "plans/saveSlots", {
    planId: plan._id,
    slots: [
      slot(day, { routineId: routine.id, activityIds: [activities[2].id] }),
      slot(tomorrow, { activityIds: [activities[1].id] }),
    ],
  });
  const detail = (
    await request(
      seller,
      `coverage/plans/detail?input=${encodeURIComponent(JSON.stringify({ planId: plan._id }))}`,
    )
  ).data;
  expect(
    detail.slots[0].storeWork.activities.map((/** @type {any} */ a) => a.name),
  ).toEqual(["Collection", "Countering", "Count stock"]);
  await command(seller, "plans/submit", { planId: plan._id });
  await command(manager, "plans/approve", { planId: plan._id });
  await activateDue(
    { db: h.db, recordChange: async () => {}, publish: async () => {} },
    now,
  );
  const planned =
    await h.db`select * from planned_visits order by service_date`;
  expect(planned).toHaveLength(2);
  expect(planned[0].approved_snapshot.storeWork.routineName).toBe(
    "Sample follow-up",
  );
  expect(
    planned[1].approved_snapshot.storeWork.activities.map(
      (/** @type {any} */ a) => a.name,
    ),
  ).toEqual(["Countering"]);
  const key = await deviceKey(),
    deviceId = await registerDevice(h, {
      profileId: seller.id,
      orgUnitId: unit.id,
      key,
    });
  // The fixture clock is fixed; SQL now() remains real. Supply a clean, unexpired sample assessment at the fixture instant.
  await h.db`insert into device_integrity_assessments(device_id,rooted,tampered,source,observed_at,expires_at,evidence) values (${deviceId},false,false,'android-self-report',${new Date(now)},${new Date(now + 86400000)},${{ verified: false }})`;
  const { body: tokens } = await nativeSignIn(
    h,
    seller.email,
    password,
    "field-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(typeof tokens.accessToken, JSON.stringify(tokens.error)).toBe(
    "string",
  );
  const binding = await bind(h, tokens.accessToken, deviceId, key);
  expect(binding.body.bindingStatus, JSON.stringify(binding.body.error)).toBe(
    "bound",
  );
  native = { access: tokens.accessToken, deviceId, key };
  const r = await download();
  expect(r.res.status).toBe(200);
  const stops = r.body.bundles[0].data.plannedVisits;
  expect(
    stops[0].agenda.storeWork.activities.map((/** @type {any} */ a) => a.name),
  ).toEqual(["Collection", "Countering", "Count stock"]);
  expect(stops[1].serviceDate).toBe(tomorrow);
  expect(stops[1].agenda.storeWork.activities[0].name).toBe("Countering");
});

test("renaming and retiring a master never rewrites approved work; inactive selections are refused", async () => {
  await post(admin, "store-work/activity", {
    id: activities[0].id,
    name: "Renamed collection",
    active: false,
    reason: "Sample retirement",
  });
  await post(admin, "store-work/routine", {
    id: routine.id,
    name: "Renamed routine",
    active: false,
    activityIds: activities.slice(0, 2).map((a) => a.id),
    reason: "Sample retirement",
  });
  const r = await download();
  expect(r.res.status).toBe(200);
  const work = r.body.bundles[0].data.plannedVisits[0].agenda.storeWork;
  expect(work.routineName).toBe("Sample follow-up");
  expect(work.activities[0].name).toBe("Collection");
  const revision = await command(seller, "plans/create", {
    assigneeProfileId: seller.id,
    localMonth: "2030-12",
  });
  const invalid = await request(seller, "coverage/plans/saveSlots", {
    idempotencyKey: crypto.randomUUID(),
    planId: revision._id,
    slots: [slot("2030-12-01", { routineId: routine.id })],
  });
  expect(invalid.status).toBe(422);
  expect(
    await h.db`select * from coverage_plan_slots where plan_id=${revision._id}`,
  ).toHaveLength(0);
  const copied = await command(seller, "plans/createRevision", {
    planId: plan._id,
    effectiveFromDate: day,
    reason: "Reuse agreed activities after master retirement",
  });
  const copiedSlots =
    await h.db`select store_work from coverage_plan_slots where plan_id=${copied._id} order by service_date`;
  expect(copiedSlots).toHaveLength(2);
  expect(copiedSlots[0].store_work.routineName).toBe("Sample follow-up");
  expect(copiedSlots[0].store_work.activities[0].name).toBe("Collection");
});

test("signed phone tick, untick, replay and scope refusal persist actual work without inventing cash or productive credit", async () => {
  const [pv] =
    await h.db`select * from planned_visits where service_date=${day}`;
  const fix = {
    latitude: 10.33,
    longitude: 123.94,
    accuracyMeters: 5,
    fixTime: now,
    provider: "gps",
    mockSignal: false,
  };
  const started = await push(
    op("visit.checkIn", {
      clientVisitId: crypto.randomUUID(),
      plannedVisitId: pv.id,
      outletId: outlet.id,
      serviceDate: day,
      intents: [],
      deviceTime: now,
      location: fix,
    }),
  );
  expect(started.status, JSON.stringify(started)).toBe("applied");
  const visitId = started.ack.entityId;
  const tick = (/** @type {boolean} */ done) =>
    op("visit.activity", {
      visitId,
      deviceTime: now,
      activity: {
        kind: "planned_activity",
        activityId: activities[0].id,
        done,
        name: "Untrusted phone name",
      },
    });
  const first = tick(true);
  expect((await push(first)).status).toBe("applied");
  expect((await push(first)).status).toBe("duplicate");
  expect((await push(tick(false))).status).toBe("applied");
  let results = (
    await request(manager, `store-work/results?planId=${plan._id}`)
  ).data;
  expect(results[0].done).toBe(false);
  expect((await push(tick(true))).status).toBe("applied");
  results = (await request(manager, `store-work/results?planId=${plan._id}`))
    .data;
  expect(results).toHaveLength(1);
  expect(results[0].done).toBe(true);
  const detail = (
    await request(
      manager,
      `coverage/plans/detail?input=${encodeURIComponent(JSON.stringify({ planId: plan._id }))}`,
    )
  ).data;
  expect(detail.storeWorkResults[0].done).toBe(true);
  expect(
    (await request(stranger, `store-work/results?planId=${plan._id}`)).status,
  ).toBe(403);
  const bad = tick(true);
  bad.payload.activity.activityId = crypto.randomUUID();
  expect((await push(bad)).status).toBe("rejected");
  const malformed = tick(true);
  malformed.payload.activity.done = "yes";
  expect((await push(malformed)).status).toBe("rejected");
  const otherVisit = tick(true);
  otherVisit.payload.visitId = crypto.randomUUID();
  expect((await push(otherVisit)).status).toBe("rejected");
  const rows =
    await h.db`select * from visit_activities where visit_id=${visitId}`;
  expect(rows).toHaveLength(3);
  expect(
    rows.every((/** @type {any} */ a) => a.activity.name === "Collection"),
  ).toBe(true);
  expect(await h.db`select * from field_collections`).toHaveLength(0);
  expect(
    isProductive(
      {
        inRoutePlan: true,
        state: "checked-out",
        activityKinds: ["planned_activity"],
      },
      {},
    ).productive,
  ).toBe(false);
  const boot = await download();
  expect(boot.res.status).toBe(200);
  expect(
    boot.body.bundles[0].data.plannedVisits[0].agenda.storeWork.activities[0]
      .done,
  ).toBe(true);
  const end = await push(
    op("visit.checkOut", {
      visitId,
      deviceTime: now + 1000,
      outcome: "completed",
      location: { ...fix, fixTime: now + 1000 },
    }),
  );
  expect(end.status, JSON.stringify(end)).toBe("applied");
  expect((await push(tick(false))).status).toBe("rejected");
});

// SP-0226: the report consumes the real public plan/approval/activation and
// signed simulated-device operations above. No physical device or live data.
/** @param {any} who @param {any} [filters] */
async function report(who, filters = {}) {
  return request(
    who,
    `coverage/plan-actual?${new URLSearchParams({ from: day, to: tomorrow, ...filters })}`,
  );
}
test("SP-0226 public plan and signed activity results reconcile by salesman/day and retain approved names", async () => {
  setSystemTime(new Date(now + 86400000));
  await h.db`update sessions set expires_at=${new Date(now + 10 * 86400000)}`;
  const r = await report(manager);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  expect(r.data.summary).toMatchObject({
    planned: 2,
    visited: 1,
    plannedActivities: 4,
    doneActivities: 1,
    followed: 0,
    followedPct: 0,
    visitPct: 50,
    missed: 0,
    outstanding: 1,
    unplanned: 0,
    plannedDays: 2,
    visitedDays: 1,
    plannedStores: 1,
    visitedStores: 1,
  });
  expect(r.data.days).toHaveLength(2);
  expect(
    r.data.days.reduce(
      (/** @type {number} */ n, /** @type {any} */ d) => n + d.totals.planned,
      0,
    ),
  ).toBe(r.data.summary.planned);
  const stop = r.data.days.find((/** @type {any} */ d) => d.date === day)
    .stops[0];
  expect(stop.status).toBe("Activities unfinished");
  expect(
    stop.activities.map((/** @type {any} */ a) => [a.name, a.done]),
  ).toEqual([
    ["Collection", true],
    ["Countering", false],
    ["Count stock", false],
  ]);
  expect(
    r.data.salesmen.find((/** @type {any} */ p) => p.profileId === seller.id)
      .totals,
  ).toEqual(r.data.summary);
  expect(r.data.prior.planned).toBe(0);
  if (process.env.SP_PLAN_ACTUAL_PROOF)
    await Bun.write(process.env.SP_PLAN_ACTUAL_PROOF, JSON.stringify(r.data));
  expect((await report(seller)).data.summary).toEqual(r.data.summary);
  expect((await report(stranger)).data.days).toHaveLength(0);
  expect((await report(stranger, { profileId: seller.id })).status).toBe(403);
});

test("SP-0226 duplicates, open/rejected/review visits and unplanned same-store calls cannot inflate followed stops", async () => {
  const [v] = await h.db`select * from visit_executions limit 1`;
  // The persisted uniqueness guard refuses a second execution for this stop.
  await expect(
    Promise.resolve(
      h.db`insert into visit_executions(organization_id,client_visit_id,planned_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time) values ('sunpride',${crypto.randomUUID()},${v.planned_visit_id},${v.assignee_profile_id},${v.outlet_id},${v.org_unit_id},${day},'planned','checked-out','pending',${new Date(now)})`,
    ),
  ).rejects.toMatchObject({ errno: "23505" });
  for (const [state, review] of [
    ["checked-out", "rejected"],
    ["checked-out", "pending_review"],
    ["checked-in", null],
  ]) {
    await h.db`update visit_executions set state=${state},late_review_status=${review} where id=${v.id}`;
    expect((await report(manager)).data.summary).toMatchObject({
      visited: 0,
      doneActivities: 0,
      followed: 0,
    });
  }
  await h.db`update visit_executions set state='checked-out',late_review_status=null where id=${v.id}`;
  await h.db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time) values ('sunpride',${crypto.randomUUID()},${v.assignee_profile_id},${v.outlet_id},${v.org_unit_id},${day},'unplanned','checked-out','pending',${new Date(now)})`;
  const r = await report(manager);
  expect(r.status).toBe(200);
  expect(r.data.summary).toMatchObject({
    planned: 2,
    visited: 1,
    actualVisits: 2,
    unplanned: 1,
    followed: 0,
    followedPct: 0,
  });
  expect(
    r.data.days.find((/** @type {any} */ d) => d.date === day).stops,
  ).toHaveLength(2);
  // Move past the second planned day: it becomes a missed stop, never disappears.
  setSystemTime(new Date(now + 2 * 86400000));
  expect((await report(manager)).data.summary).toMatchObject({
    missed: 1,
    outstanding: 0,
  });
});

test("SP-0226 latest tick/untick and all planned tasks govern followed percentage; equal prior window reconciles", async () => {
  const [v] =
    await h.db`select * from visit_executions where client_visit_id not like '' and checked_in_at is not null limit 1`;
  for (const activity of activities.slice(1)) {
    await h.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values ('sunpride',${unit.id},${v.id},${seller.id},${outlet.id},'planned_activity',${{ kind: "planned_activity", activityId: activity.id, done: true }},${new Date(now)},${new Date(now + 1000)})`;
  }
  expect((await report(manager)).data.summary).toMatchObject({
    doneActivities: 3,
    followed: 1,
    followedPct: 50,
  });
  await h.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values ('sunpride',${unit.id},${v.id},${seller.id},${outlet.id},'planned_activity',${{ kind: "planned_activity", activityId: activities[0].id, done: false }},${new Date(now)},${new Date(now + 2000)})`;
  expect((await report(manager)).data.summary).toMatchObject({
    doneActivities: 2,
    followed: 0,
  });
  const r = await report(manager, { from: tomorrow });
  expect(r.data.summary).toMatchObject({ planned: 1, missed: 1 });
  expect(r.data.prior).toMatchObject({
    planned: 1,
    visited: 1,
    doneActivities: 2,
    unplanned: 1,
  });
});

test("SP-0226 validates dates and filters before querying and refuses future or excessive windows", async () => {
  for (const filters of [
    { from: "2030-02-30" },
    { from: "2029-01-01" },
    { from: tomorrow, to: day },
    { to: "2030-12-01" },
    { territoryId: "bad" },
    { territoryType: "invented" },
    { profileId: "not-a-uuid" },
  ]) {
    expect((await report(manager, filters)).status).toBe(422);
  }
});

test("SP-0226 only approved effective slots count, including pre-activation plans but not superseded future stops", async () => {
  await h.db`update coverage_plans set status='draft' where id=${plan._id}`;
  expect((await report(manager)).data.summary.planned).toBe(0);
  await h.db`update coverage_plans set status='approved' where id=${plan._id}`;
  expect((await report(manager)).data.summary.planned).toBe(2);
  await h.db`update coverage_plans set status='superseded',active_through=${new Date(Date.parse(tomorrow + "T00:00:00+08:00"))} where id=${plan._id}`;
  expect((await report(manager)).data.summary.planned).toBe(1);
  await h.db`update coverage_plans set status='active',active_through=null where id=${plan._id}`;
  const [future] =
    await h.db`select id from planned_visits where service_date=${tomorrow}`;
  await h.db`update planned_visits set deleted_at=now() where id=${future.id}`;
  const preActivation = await report(manager);
  expect(preActivation.data.summary).toMatchObject({ planned: 2, missed: 1 });
  await h.db`update planned_visits set deleted_at=null where id=${future.id}`;
});

test("SP-0226 filters branch, territory, territory type/group, and does not ignore a super-admin branch choice", async () => {
  const [group] =
    await h.db`insert into customer_groups(code,name) values ('SAMPLE226','Sample chain') returning *`;
  await h.db`update outlets set customer_group_id=${group.id} where id=${outlet.id}`;
  await h.db`update territories set territory_type='customer_group' where id=${territory.id}`;
  for (const filters of [
    { unitId: unit.id },
    { territoryId: territory.id },
    { territoryType: "customer_group" },
    { groupId: group.id },
    {
      profileId: seller.id,
      unitId: unit.id,
      territoryId: territory.id,
      territoryType: "customer_group",
      groupId: group.id,
    },
  ]) {
    expect((await report(admin, filters)).data.summary.planned).toBe(2);
  }
  expect(
    (await report(manager, { territoryType: "location" })).data.days,
  ).toHaveLength(0);
  expect(
    (await report(manager, { groupId: crypto.randomUUID() })).data.days,
  ).toHaveLength(0);
  const [branch] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,parent_id,effective_from) values ('sunpride','EMPTY226','Sample empty branch','branch','active',${unit.id},'2020-01-01') returning *`;
  expect((await report(admin, { unitId: branch.id })).data.days).toHaveLength(
    0,
  );
});

test("SP-0226 current person, source branch and current store scope independently guard historical detail/options", async () => {
  const branches = [];
  for (const code of ["A226", "B226"]) {
    const [b] =
      await h.db`insert into org_units(organization_id,code,name,type_code,status,parent_id,effective_from) values ('sunpride',${code},${code},'branch','active',${unit.id},'2020-01-01') returning *`;
    branches.push(b);
  }
  const [a, b] = branches;
  for (const p of [manager, seller]) {
    await h.db`update profiles set org_unit_id=${a.id} where id=${p.id}`;
    await h.db`update employee_assignments set org_unit_id=${a.id} where profile_id=${p.id}`;
  }
  await h.db`update coverage_plans set org_unit_id=${a.id} where assignee_profile_id=${seller.id}`;
  await h.db`update visit_executions set org_unit_id=${a.id} where assignee_profile_id=${seller.id}`;
  await h.db`update territory_ownerships set org_unit_id=${a.id} where territory_id=${territory.id}`;
  expect((await report(manager)).data.summary.planned).toBe(2);
  const [extra] =
    await h.db`select id from visit_executions where source='unplanned' limit 1`;
  await h.db`update visit_executions set org_unit_id=${b.id} where id=${extra.id}`;
  expect((await report(manager)).data.summary.unplanned).toBe(0);
  expect((await report(manager, { unitId: b.id })).status).toBe(403);
  await h.db`update territory_ownerships set org_unit_id=${b.id} where territory_id=${territory.id}`;
  const hidden = await report(manager);
  expect(hidden.status).toBe(200);
  expect(hidden.data.days).toHaveLength(0);
  expect(hidden.data.options.territories).toHaveLength(0);
  expect(hidden.data.options.groups).toHaveLength(0);
  // Restore store visibility, then withdraw the person's current scope instead.
  await h.db`update territory_ownerships set org_unit_id=${a.id} where territory_id=${territory.id}`;
  await h.db`update employee_assignments set org_unit_id=${b.id} where profile_id=${seller.id}`;
  await h.db`update profiles set org_unit_id=${b.id} where id=${seller.id}`;
  const moved = await report(manager);
  expect(moved.data.days).toHaveLength(0);
  expect(
    moved.data.options.people.some(
      (/** @type {any} */ p) => p.id === seller.id,
    ),
  ).toBe(false);
});
