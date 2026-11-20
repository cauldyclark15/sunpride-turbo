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
