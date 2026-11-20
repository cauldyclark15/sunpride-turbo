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
  install,
  command,
  activateDue,
} from "../src/domains/coverage/index.js";
import { install as installSync } from "../src/domains/fieldsync/index.js";
import { identityHooks } from "../src/domains/org/identity.js";
import { setHooks } from "../src/core/hooks.js";
import { capabilitiesFor } from "../src/core/capabilities.js";
import { read } from "../src/domains/coverage/reads.js";
import { localDate, manilaDate, DAY } from "../src/domains/coverage/model.js";
import { weeklyWindow } from "../src/domains/coverage/monthly-routes.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
/** @type {any} */ let platform;
/** @type {any} */ let unit;
/** @type {any} */ let sales;
/** @type {any} */ let manager;
/** @type {any} */ let other;
/** @type {any} */ let legacy;
/** @type {any} */ let plan;
/** @type {any[]} */ let stores = [];
let now = 0,
  date = "",
  month = "";
const password = "fixture-only-not-a-real-account";
/** @param {any} p @param {number} [at] */
const ctx = (p, at = now) => ({
  db: h.db,
  now: at,
  actor: {
    profileId: p.id,
    userId: p.user_id,
    subject: p.user_id,
    role: p.role,
    orgUnitId: unit.id,
    capabilities: new Set(capabilitiesFor(p.role)),
  },
  publish: async () => {},
});
/** @param {any} p @param {string} action @param {any} b @param {number} [at] */
const run = (p, action, b, at = now) =>
  command(ctx(p, at), platform, action, {
    idempotencyKey: crypto.randomUUID(),
    ...b,
  });
/** @param {string} name @param {string} role @param {string|null} [boss] */
async function person(name, role, boss = null) {
  const id = await createUser(h, `${name}@example.test`, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values (${id},${id},${name},${`${name}@example.test`},${role},'active',${unit.id}) returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,supervisor_id,effective_from,actor_subject,reason) values (${p.id},${unit.id},${role},${boss},'2020-01-01',${id},'SP-0224 fixture')`;
  return p;
}
const roster = () =>
  stores.slice(0, 2).map((o) => ({
    outletId: o.id,
    territoryId: o.territory_id,
    ...(o.route_id ? { routeId: o.route_id } : {}),
    frequency: "monthly",
    preferredWeekdays: [],
    customLocalDates: [],
    priority: 1,
    expectedDurationMinutes: 20,
    requiredObjectives: ["sell"],
  }));
/** @param {string} day @param {any} [o] @param {number} [sequence] */
const slot = (day, o = stores[0], sequence = 1) => ({
  slotKey: `${o.id}:${day}`,
  serviceDate: day,
  kind: "outlet_visit",
  outletId: o.id,
  ...(o.route_id ? { routeId: o.route_id } : {}),
  sequence,
  expectedDurationMinutes: 20,
  requiredObjectives: ["sell"],
  intents: ["sell"],
});
/** @param {any} p */
async function cookie(p) {
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions(token_hash,user_id,app,expires_at) values (${new Bun.CryptoHasher("sha256").update(token).digest("hex")},${p.user_id},'web',${new Date(now + DAY)})`;
  return `sp_session=${token}`;
}
/** @param {string} session @param {string} action @param {any} body */
async function post(session, action, body) {
  const res = await h.fetch(`/api/v1/coverage/${action}`, {
    method: "POST",
    headers: { cookie: session, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  });
  const data = await res.json();
  expect({
    status: res.status,
    error: res.status === 200 ? null : data,
  }).toEqual({ status: 200, error: null });
  return /** @type {any} */ (data);
}
beforeAll(async () => {
  const real = Date.now();
  const noon = localDate(manilaDate(real)) + 12 * 3600000;
  setSystemTime(new Date(noon > real ? noon : noon + DAY));
  now = Date.now();
  date = manilaDate(now);
  month = date.slice(0, 7);
  h = await startHarness({
    installers: [
      (/** @type {any} */ r, /** @type {any} */ p) => {
        platform = p;
        install(r, p);
      },
      installSync,
      () => setHooks(identityHooks({})),
    ],
  });
  [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','SUNPRIDE','Sample team','region','active','2020-01-01') returning *`;
  manager = await person("Manager224", "manager");
  sales = await person("Sales224", "sales", manager.id);
  other = await person("Other224", "sales", manager.id);
  [legacy] =
    await h.db`insert into routes(organization_id,code,name,status,effective_from,created_by) values ('sunpride','OLD224','Legacy weekday route','active','2020-01-01',${manager.user_id}) returning *`;
  for (const [i, type] of ["location", "customer_group"].entries()) {
    const [t] =
      await h.db`insert into territories(organization_id,code,name,territory_type,status,effective_from,created_by) values ('sunpride',${`T224-${i}`},${`Sample ${type}`},${type},'active','2020-01-01',${manager.user_id}) returning *`;
    await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values (${t.id},${unit.id},'2020-01-01',${manager.user_id},'Fixture')`;
    await h.db`insert into territory_salespeople(territory_id,profile_id,kind,effective_from,actor_subject,reason) values (${t.id},${sales.id},'primary','2020-01-01',${manager.user_id},'Fixture')`;
    if (i === 0)
      await h.db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values (${legacy.id},${t.id},'2020-01-01',${manager.user_id},'Fixture')`;
    const [o] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,visit_frequency_days,visit_frequency_per_month,created_by) values ('sunpride',${`O224-${i}`},${`Sample store ${i}`},'active',${unit.id},7,4,${manager.user_id}) returning *`;
    await h.db`insert into outlet_assignments(outlet_id,territory_id,route_id,sequence,effective_from,actor_subject,reason) values (${o.id},${t.id},${i === 0 ? legacy.id : null},1,'2020-01-01',${manager.user_id},'Fixture')`;
    stores.push({
      ...o,
      territory_id: t.id,
      route_id: i === 0 ? legacy.id : null,
    });
  }
  const [omitted] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,visit_frequency_days,created_by) values ('sunpride','O224-missing','Sample omitted customer','active',${unit.id},30,${manager.user_id}) returning *`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,sequence,effective_from,actor_subject,reason) values (${omitted.id},${stores[1].territory_id},2,'2020-01-01',${manager.user_id},'Fixture')`;
  stores.push(omitted);
}, 30000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    setSystemTime();
  }
});

test("salesman cookie workflow: territory types, return, approval creates ordered dated routes, replay and automatic activation", async () => {
  const seller = await cookie(sales),
    boss = await cookie(manager);
  plan = await post(seller, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: month,
  });
  await post(seller, "plans/saveOutlets", {
    planId: plan._id,
    outlets: roster(),
  });
  const slots = [slot(date, stores[0], 2), slot(date, stores[1], 1)];
  const tomorrow = manilaDate(localDate(date) + DAY);
  if (tomorrow.startsWith(month)) slots.push(slot(tomorrow));
  await post(seller, "plans/saveSlots", { planId: plan._id, slots });
  const detail = await read(ctx(sales), "plans/detail", { planId: plan._id });
  expect(
    detail.frequencyRequirements.find(
      (/** @type {any} */ r) => r.outletId === stores[0].id,
    ).expected,
  ).toBe(4);
  expect(
    detail.frequencyRequirements.find(
      (/** @type {any} */ r) => r.outletId === stores[2].id,
    ).planned,
  ).toBe(0);
  await post(seller, "plans/submit", { planId: plan._id });
  await post(boss, "plans/returnPlan", {
    planId: plan._id,
    reason: "Review the missing visits",
  });
  expect(
    (await read(ctx(sales), "discovery/attribution", { planId: plan._id }))
      .latestReturnReason,
  ).toBe("Review the missing visits");
  await post(seller, "plans/submit", { planId: plan._id });
  const exceptions = await read(ctx(manager), "exceptions/forPlan", {
    planId: plan._id,
    paginationOpts: { numItems: 100, cursor: null },
  });
  expect(
    exceptions.page.some((/** @type {any} */ e) => e.code === "territory_only"),
  ).toBe(false);
  const body = { planId: plan._id, idempotencyKey: crypto.randomUUID() };
  plan = await run(manager, "plans/approve", body);
  expect(await run(manager, "plans/approve", body)).toEqual(plan);
  const routes =
    await h.db`select * from coverage_daily_routes where plan_id=${plan._id} order by service_date`;
  expect(routes).toHaveLength(new Set(slots.map((s) => s.serviceDate)).size);
  expect(routes[0].code).toBe("001");
  expect(
    (await read(ctx(manager), "review", { planId: plan._id })).routes[0].code,
  ).toBe(`Route 001 · ${date}`);
  expect(await h.db`select * from routes`).toHaveLength(1);
  expect(await h.db`select * from route_salespeople`).toHaveLength(0);
  expect(await h.db`select * from planned_visits`).toHaveLength(0);
  await activateDue(platform, now);
  const visits =
    await h.db`select * from planned_visits where plan_id=${plan._id} order by service_date,(approved_snapshot->>'sequence')::integer`;
  expect(visits.map((/** @type {any} */ v) => v.outlet_id).slice(0, 2)).toEqual(
    [stores[1].id, stores[0].id],
  );
  expect(visits[0].approved_snapshot.dailyRouteId).toBe(routes[0].id);
  expect(visits[1].approved_snapshot.dailyRouteId).toBe(routes[0].id);
  await activateDue(platform, now);
  expect(await h.db`select * from planned_visits`).toHaveLength(slots.length);
});

test("real signed Field download gets MCP stops, today's dated header and each day's agenda; legacy master edits do not change approved facts", async () => {
  await h.db`update outlets set name='Changed live name' where id=${stores[0].id}`;
  await h.db`update routes set code='RENAMED224' where id=${legacy.id}`;
  const key = await deviceKey();
  const deviceId = await registerDevice(h, {
    profileId: sales.id,
    orgUnitId: unit.id,
    key,
  });
  const { body: tokens } = await nativeSignIn(
    h,
    sales.email,
    password,
    "field-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(typeof tokens.accessToken).toBe("string");
  expect(
    (await bind(h, tokens.accessToken, deviceId, key)).body.bindingStatus,
  ).toBe("bound");
  const download = () =>
    signedPost(
      h,
      { access: tokens.accessToken, deviceId, key },
      "/api/sync/pull",
      {
        version: 2,
        app: "field-android",
        deviceId,
        since: null,
        pageCursor: null,
        scopes: [
          {
            scopeId: unit.id,
            projection: "field.bundle",
            params: { dayFrom: date },
          },
        ],
        limit: 100,
      },
    );
  const { res, body } = await download();
  expect({
    status: res.status,
    error: res.status === 200 ? null : body,
  }).toEqual({ status: 200, error: null });
  const data = body.bundles[0].data;
  expect(data.route.code).toBe(`001 · ${date}`);
  expect(
    data.plannedVisits.slice(0, 2).map((/** @type {any} */ v) => v.outletId),
  ).toEqual([stores[1].id, stores[0].id]);
  expect(data.plannedVisits[0].agenda.beat).toBe(`Route 001 · ${date}`);
  expect(
    data.outlets.find((/** @type {any} */ o) => o.id === stores[0].id).name,
  ).toBe("Sample store 0");
  expect(
    data.outlets.find((/** @type {any} */ o) => o.id === stores[0].id).routeId,
  ).toBe(legacy.id);
  expect(
    data.outlets.find((/** @type {any} */ o) => o.id === stores[1].id).routeId,
  ).toBeNull();
  if (data.plannedVisits.length > 2) {
    expect(data.plannedVisits[2].agenda.beat).not.toContain("Route 001");
    // Future stops stay available, but cannot supply today's route on a day off.
    await h.db`update planned_visits set status='cancelled' where plan_id=${plan._id} and service_date=${date}::date`;
    try {
      const fence = await download();
      expect(fence.res.status).toBe(409);
      expect(fence.body.error.code).toBe("rebootstrap_required");
      const futureOnly = await download();
      expect(futureOnly.res.status).toBe(200);
      expect(futureOnly.body.bundles[0].data.plannedVisits).toHaveLength(1);
      expect(futureOnly.body.bundles[0].data.route).toBeNull();
    } finally {
      await h.db`update planned_visits set status='planned' where plan_id=${plan._id} and service_date=${date}::date`;
    }
  }
});

test("weekly revisions need re-approval, retain earlier route history and count retained month prefixes", async () => {
  // Fixed service clock for the weekly boundary proof; no auth or phone claim here.
  const clock = Date.parse("2030-11-07T12:00:00+08:00");
  const week = weeklyWindow(clock);
  let p = await run(
    sales,
    "plans/create",
    { assigneeProfileId: sales.id, localMonth: "2030-11" },
    clock,
  );
  await run(
    sales,
    "plans/saveOutlets",
    {
      planId: p._id,
      outlets: roster().map((o, i) =>
        i === 0
          ? {
              ...o,
              frequency: "custom",
              customLocalDates: ["2030-11-08", week.weekStart],
            }
          : o,
      ),
    },
    clock,
  );
  await run(
    sales,
    "plans/saveSlots",
    { planId: p._id, slots: [slot("2030-11-08"), slot(week.weekStart)] },
    clock,
  );
  await run(sales, "plans/submit", { planId: p._id }, clock);
  p = await run(manager, "plans/approve", { planId: p._id }, clock);
  await activateDue(platform, clock);
  const oldRoutes =
    await h.db`select * from coverage_daily_routes where plan_id=${p._id} order by service_date`;
  expect((await read(ctx(sales, clock), "weekly", {})).reminder).toBe(true);
  await run(
    sales,
    "plans/reviewWeek",
    { planId: p._id, weekStart: week.weekStart },
    clock,
  );
  expect((await read(ctx(sales, clock), "weekly", {})).plans[0].reviewed).toBe(
    true,
  );
  const rev = await run(
    sales,
    "plans/createRevision",
    {
      planId: p._id,
      effectiveFromDate: week.weekStart,
      reason: "Weekly adjustments",
    },
    clock,
  );
  await expect(
    run(
      sales,
      "plans/reviewWeek",
      { planId: p._id, weekStart: week.weekStart },
      clock,
    ),
  ).rejects.toThrow("pending changes");
  const detail = await read(ctx(sales, clock), "plans/detail", {
    planId: rev._id,
  });
  expect(detail.slots).toHaveLength(1);
  expect(
    detail.frequencyRequirements.find(
      (/** @type {any} */ r) => r.outletId === stores[0].id,
    ).planned,
  ).toBe(2);
  await run(
    sales,
    "plans/saveSlots",
    { planId: rev._id, slots: [slot(week.weekStart, stores[1])] },
    clock,
  );
  await run(sales, "plans/submit", { planId: rev._id }, clock);
  await expect(
    run(sales, "plans/approve", { planId: rev._id }, clock),
  ).rejects.toThrow();
  await expect(
    run(
      sales,
      "plans/reviewWeek",
      { planId: rev._id, weekStart: week.weekStart },
      clock,
    ),
  ).rejects.toThrow("Approve changes");
  await run(manager, "plans/approve", { planId: rev._id }, clock);
  expect(
    (await h.db`select status from coverage_plans where id=${p._id}`)[0].status,
  ).toBe("active");
  await activateDue(platform, localDate(week.weekStart) + 12 * 3600000);
  const olds =
    await h.db`select * from planned_visits where plan_id=${p._id} order by service_date`;
  expect(olds.map((/** @type {any} */ v) => v.status)).toEqual([
    "planned",
    "cancelled",
  ]);
  expect(
    await h.db`select * from coverage_daily_routes where plan_id=${p._id} order by service_date`,
  ).toEqual(oldRoutes);
  expect(
    (await read(ctx(sales, clock), "plans/detail", { planId: p._id }))
      .dailyRoutes,
  ).toHaveLength(2);
  await expect(
    read(ctx(other, clock), "plans/detail", { planId: p._id }),
  ).rejects.toThrow("only own");
  await expect(
    read(ctx(other, clock), "weekly", { assigneeProfileId: sales.id }),
  ).rejects.toThrow("only own");
});

test("atomic save-and-submit rolls back invalid edits; a pristine month-start route can be revised without changing old history", async () => {
  const clock = Date.parse("2031-10-15T12:00:00+08:00");
  const p = await run(
    sales,
    "plans/create",
    { assigneeProfileId: sales.id, localMonth: "2031-11" },
    clock,
  );
  await run(
    sales,
    "plans/saveDraft",
    {
      planId: p._id,
      outlets: roster(),
      slots: [slot("2031-11-01")],
      submit: false,
    },
    clock,
  );
  const before = await read(ctx(sales, clock), "plans/detail", {
    planId: p._id,
  });
  await expect(
    run(
      sales,
      "plans/saveDraft",
      { planId: p._id, outlets: [], slots: [slot("2031-12-01")], submit: true },
      clock,
    ),
  ).rejects.toThrow("outside plan");
  expect(
    await read(ctx(sales, clock), "plans/detail", { planId: p._id }),
  ).toEqual(before);
  const submitted = await run(
    sales,
    "plans/saveDraft",
    {
      planId: p._id,
      outlets: roster(),
      slots: [slot("2031-11-01", stores[1])],
      submit: true,
    },
    clock,
  );
  expect(submitted.status).toBe("submitted");
  await run(manager, "plans/approve", { planId: p._id }, clock);
  const rev = await run(
    sales,
    "plans/createRevision",
    {
      planId: p._id,
      effectiveFromDate: "2031-11-01",
      reason: "Month-start weekly review",
    },
    clock,
  );
  await run(sales, "plans/submit", { planId: rev._id }, clock);
  await run(manager, "plans/approve", { planId: rev._id }, clock);
  const routes =
    await h.db`select plan_id,id from coverage_daily_routes where plan_id in (${p._id},${rev._id})`;
  expect(routes).toHaveLength(2);
  expect(routes[0].id).not.toBe(routes[1].id);
  await activateDue(platform, localDate("2031-11-01") + 12 * 3600000);
  expect(
    (await h.db`select status from coverage_plans where id=${p._id}`)[0].status,
  ).toBe("superseded");
  expect(
    await h.db`select * from planned_visits where plan_id=${rev._id}`,
  ).toHaveLength(1);
});

test("Saturday deadline uses Manila boundaries, Sunday is overdue, Monday starts the next review cycle", () => {
  const saturday = weeklyWindow(Date.parse("2030-11-09T23:59:59+08:00"));
  expect(saturday.weekStart).toBe("2030-11-11");
  expect(saturday.dueDate).toBe("2030-11-09");
  expect(saturday.overdue).toBe(false);
  expect(weeklyWindow(Date.parse("2030-11-10T00:00:00+08:00")).overdue).toBe(
    true,
  );
  expect(weeklyWindow(Date.parse("2030-11-11T00:00:00+08:00")).weekStart).toBe(
    "2030-11-18",
  );
});
