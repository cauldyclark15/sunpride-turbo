import { test, expect, beforeAll, afterAll } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { sha256Hex } from "../src/core/util.js";
import { addDays } from "../src/domains/analytics/measures.js";
const { installTerritoryScenarios, workload, tourKm } =
  await import("../src/domains/coverage/territory-scenarios.js");

/** @type {any} */ let h;
/** @type {any} */ let f;
/** @type {Record<string,string>} */ const cookies = {};
/** @type {Record<string,string>} */ const t = {};
/** @type {Record<string,string>} */ const s = {};
beforeAll(async () => {
  h = await startHarness({
    installers: [
      (/** @type {any} */ router) => installTerritoryScenarios(router),
    ],
  });
  f = await analyticsFixture(h);
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${f.boss},${f.root},'super_admin','2020-01-01','fixture','fixture')`;
  /** @param {string} name @param {string} role @param {string} unit */
  async function person(name, role, unit) {
    const email = `${name}@example.com`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},'not-a-password-hash') returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},${name},${email},${role},'active',${unit}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},'2020-01-01','fixture','fixture')`;
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex("sps_" + name)},'web',now()+interval '1 day')`;
    cookies[name] = "sp_session=sps_" + name;
  }
  await person("ops-root", "operations", f.root);
  await person("ops-b", "operations", f.b);
  for (const r of await h.db`select id,code from territories`) t[r.code] = r.id;
  for (const r of await h.db`select id,code from outlets where code in ('S4','S8','S12','S0')`)
    s[r.code] = r.id;
  // Pins and potential make the map and travel estimate real for T0/T1.
  let i = 0;
  for (const code of ["S4", "S8", "S12"]) {
    await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at) values(${s[code]},${10.3 + i * 0.01},${123.9 + i * 0.01},30,'fixture','verified','2020-01-01','fixture',now())`;
    i++;
  }
  await h.db`update outlets set sales_potential=1000 where code in ('S4','S8')`;
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

test("F-224 workload counts service, provisional travel and capacity; unknown potential and pins stay explicit", () => {
  expect(tourKm([[10, 124]])).toBe(0);
  const a = {
    dayMinutes: 480,
    sellingDays: 24,
    serviceMinutes: 20,
    visitsPer4Weeks: 4,
    travelKmh: 20,
    roadFactor: 1.3,
  };
  const w = workload(
    [
      { lat: 10, lon: 124, potential: 100, visits: 4, service: 20 },
      { lat: 10.01, lon: 124, potential: null, visits: 2, service: 30 },
      { lat: null, lon: null, potential: 50, visits: 4, service: 20 },
    ],
    1,
    a,
  );
  expect(w.outlets).toBe(3);
  expect(w.potential).toBe(150);
  expect(w.potentialMissing).toBe(1);
  expect(w.unpinned).toBe(1);
  expect(w.serviceMinutes).toBe(4 * 20 + 2 * 30 + 4 * 20);
  expect(w.travelMinutes).toBeGreaterThan(0);
  expect(w.capacityMinutes).toBe(480 * 24);
  expect(workload([], 0, a).loadPct).toBeNull();
});

test("F-224 simulate → save → independent publish through the ORG assignment writer, stale and scope refused", async () => {
  const moves = [{ outletId: s.S4, toTerritoryId: t.T1 }];
  const sim = await call("/api/v1/coverage/territory-scenarios/simulate", {
    moves,
  });
  expect(sim.status).toBe(200);
  const t0 = sim.body.territories.find(
    (/** @type {any} */ x) => x.territoryId === t.T0,
  );
  const t1 = sim.body.territories.find(
    (/** @type {any} */ x) => x.territoryId === t.T1,
  );
  expect(t0.after.outlets).toBe(t0.before.outlets - 1);
  expect(t1.after.outlets).toBe(t1.before.outlets + 1);
  expect(t0.before.potential - t0.after.potential).toBe(1000);
  expect(t0.movedOut).toBe(1);
  expect(t1.movedIn).toBe(1);
  expect(
    t1.pins.some((/** @type {any} */ p) => p.code === "S4" && p.moved),
  ).toBe(true);
  // Team B operations cannot plan moves between Team A territories.
  expect(
    (
      await call(
        "/api/v1/coverage/territory-scenarios/simulate",
        { moves },
        cookies["ops-b"],
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call("/api/v1/coverage/territory-scenarios/simulate", {
        moves: [{ outletId: s.S4, toTerritoryId: t.T0 }],
      })
    ).status,
  ).toBe(400);
  const effectiveOn = addDays(f.today, 3);
  expect(
    (
      await call("/api/v1/coverage/territory-scenarios/save", {
        name: "TEST",
        effectiveOn: f.today,
        moves,
        idempotencyKey: "past",
      })
    ).status,
  ).toBe(400);
  const body = {
    name: "TEST move S4 to T1",
    effectiveOn,
    moves,
    idempotencyKey: "k1",
  };
  const saved = await call("/api/v1/coverage/territory-scenarios/save", body);
  expect(saved.status).toBe(200);
  expect(
    (await call("/api/v1/coverage/territory-scenarios/save", body)).body.id,
  ).toBe(saved.body.id);
  expect(
    (
      await call("/api/v1/coverage/territory-scenarios/save", {
        ...body,
        name: "changed",
      })
    ).status,
  ).toBe(409);
  const publish = {
    scenarioId: saved.body.id,
    contentHash: saved.body.contentHash,
  };
  // The preparer cannot publish their own territory change.
  expect(
    (await call("/api/v1/coverage/territory-scenarios/publish", publish))
      .status,
  ).toBe(403);
  expect(
    (
      await call(
        "/api/v1/coverage/territory-scenarios/publish",
        { ...publish, contentHash: "x" },
        cookies["ops-root"],
      )
    ).status,
  ).toBe(409);
  const done = await call(
    "/api/v1/coverage/territory-scenarios/publish",
    publish,
    cookies["ops-root"],
  );
  expect(done.status).toBe(200);
  expect(done.body.assignments).toBe(1);
  // A retry by the same publisher replays the result, counting assignments, not characters.
  const again = await call(
    "/api/v1/coverage/territory-scenarios/publish",
    publish,
    cookies["ops-root"],
  );
  expect(again.body).toEqual({ status: "published", assignments: 1 });
  const rows =
    await h.db`select t.code,a.effective_from,a.effective_to,a.reason from outlet_assignments a join territories t on t.id=a.territory_id where a.outlet_id=${s.S4} and a.deleted_at is null order by a.effective_from`;
  const from = new Date(effectiveOn + "T00:00:00+08:00").getTime();
  expect(rows.map((/** @type {any} */ r) => r.code)).toEqual(["T0", "T1"]);
  expect(+new Date(rows[0].effective_to)).toBe(from);
  expect(+new Date(rows[1].effective_from)).toBe(from);
  expect(rows[1].reason).toContain("F-224");
  // Today the store is still in T0: the move is prospective.
  const [{ territory_id }] =
    await h.db`select territory_id from analytics_store_scope where id=${s.S4}`;
  expect(territory_id).toBe(t.T0);
  const read = await call("/api/v1/coverage/territory-scenarios");
  const sc = read.body.scenarios.find(
    (/** @type {any} */ x) => x.id === saved.body.id,
  );
  expect(sc.status).toBe("published");
  expect(sc.publishedBy).toBe("ops-root");
});

test("F-224 a membership change after simulation makes the scenario stale", async () => {
  const saved = await call("/api/v1/coverage/territory-scenarios/save", {
    name: "TEST stale",
    effectiveOn: addDays(f.today, 4),
    moves: [{ outletId: s.S8, toTerritoryId: t.T1 }],
    idempotencyKey: "k2",
  });
  expect(saved.status).toBe(200);
  // Another office change lands first (a store joins T0 today).
  await h.db`update outlet_assignments set effective_to=now() - interval '1 second' where outlet_id=${s.S12} and deleted_at is null and effective_to is null`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${s.S12},${t.T1},now() - interval '1 second','fixture','fixture')`;
  const r = await call(
    "/api/v1/coverage/territory-scenarios/publish",
    { scenarioId: saved.body.id, contentHash: saved.body.contentHash },
    cookies["ops-root"],
  );
  expect(r.status).toBe(409);
  expect(r.body.error.message).toContain("simulate again");
  const [{ n }] =
    await h.db`select count(*)::int n from outlet_assignments where outlet_id=${s.S8} and deleted_at is null`;
  expect(n).toBe(1);
  // Only the preparer may withdraw it; the publisher cannot.
  expect(
    (
      await call(
        "/api/v1/coverage/territory-scenarios/discard",
        { scenarioId: saved.body.id },
        cookies["ops-root"],
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call("/api/v1/coverage/territory-scenarios/discard", {
        scenarioId: saved.body.id,
      })
    ).body.status,
  ).toBe("discarded");
});

test("F-224 a store held by an approved coverage plan is refused at save with the first free day", async () => {
  const [plan] = await h.db`select id from coverage_plans where id=${f.plan}`;
  await h.db`insert into coverage_plan_outlets(plan_id,outlet_id,territory_id,frequency,priority,expected_duration_minutes,content_revision,updated_by)
    select ${plan.id},${s.S0},territory_id,'weekly',1,10,1,'fixture' from analytics_store_scope where id=${s.S0}`;
  const r = await call("/api/v1/coverage/territory-scenarios/save", {
    name: "TEST locked",
    effectiveOn: addDays(f.today, 1),
    moves: [{ outletId: s.S0, toTerritoryId: t.T1 }],
    idempotencyKey: "k3",
  });
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe("plan_locked");
  expect(r.body.error.message).toContain(
    "Store 0 is in an approved coverage plan until",
  );
});
