import { test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { installTerritoryScenarios } from "../src/domains/coverage/territory-scenarios.js";
import {
  applyScenarioBoundaries,
  geometry,
  contains,
} from "../src/domains/coverage/scenario-planning.js";
import { sha256Hex } from "../src/core/util.js";
import { manilaDate } from "../src/domains/visits/shared.js";
async function fixture(
  /** @type {any} */ env = {},
  publisherRole = "operations",
) {
  const h = await startHarness({
    env,
    installers: [
      org,
      (/** @type {any} */ r, /** @type {any} */ p) =>
        installTerritoryScenarios(r, p),
    ],
  });
  const unit = crypto.randomUUID(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    route = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE company','national','active','2020-01-01')`;
  /** @type {string[]} */ const cookies = [];
  for (const [name, role] of [
    ["prepare", "admin"],
    ["publish", publisherRole],
  ]) {
    const [u] =
      await h.db`insert into users(email,password_hash) values(${name + "@example.test"},'not-a-login-hash') returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},${name},${name + "@example.test"},${role},'active',${unit}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},'2020-01-01','SAMPLE','SAMPLE')`;
    const token = "sps_sample_" + name;
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
    cookies.push("sp_session=" + token);
  }
  for (const [id, code] of [
    [a, "A"],
    [b, "B"],
  ]) {
    await h.db`insert into territories(id,organization_id,code,name,channel,status,effective_from,created_by) values(${id},'sunpride',${code},${"SAMPLE " + code},'general_trade','active','2020-01-01','SAMPLE')`;
    await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${id},${unit},'2020-01-01','SAMPLE','SAMPLE')`;
  }
  await h.db`insert into routes(id,organization_id,code,name,status,effective_from,created_by) values(${route},'sunpride','SAMPLE-R','SAMPLE whole beat','active','2020-01-01','SAMPLE')`;
  await h.db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values(${route},${a},'2020-01-01','SAMPLE','SAMPLE')`;
  const stores = [];
  for (let i = 0; i < 3; i++) {
    const [o] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride',${"SAMPLE-" + i},${"SAMPLE store " + i},'active',${unit},'general_trade','SAMPLE') returning id`;
    await h.db`insert into outlet_assignments(outlet_id,territory_id,route_id,sequence,effective_from,actor_subject,reason) values(${o.id},${i < 2 ? a : b},${i < 2 ? route : null},${i < 2 ? i + 1 : null},'2020-01-01','SAMPLE','SAMPLE')`;
    await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,status,effective_from,proposed_by,source,proposed_at) values(${o.id},${10 + i / 10},${123 + i / 10},100,'verified','2020-01-01','SAMPLE','SAMPLE','2020-01-01')`;
    stores.push(o.id);
  }
  const day = manilaDate(Date.now() + 86400000);
  /** @param {string} path @param {any} [body] @param {number} [person] */
  async function call(path, body, person = 0) {
    const r = await h.fetch("/api/v1/coverage/territory-scenarios" + path, {
      method: body ? "POST" : "GET",
      headers: { cookie: cookies[person], "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  }
  return { h, a, b, route, stores, day, call };
}
test("F-224 whole route expands every stop, preserves sequence through ORG, and discloses failed road routing as SAMPLE", async () => {
  let available = true,
    calls = 0;
  const provider = Bun.serve({
    port: 0,
    fetch(req) {
      calls++;
      expect(new URL(req.url).pathname).toContain("/route/v1/driving/");
      return available
        ? Response.json({
            code: "Ok",
            routes: [{ duration: 600, distance: 1000 }],
          })
        : new Response("unavailable", { status: 503 });
    },
  });
  const f = await fixture({ ROUTING_OSRM_ORIGIN: provider.url.origin });
  try {
    const body = {
      moves: [],
      plan: {
        routeMoves: [{ routeId: f.route, toTerritoryId: f.b }],
        routingMode: "road",
      },
    };
    const sim = await f.call("/simulate", body);
    expect(sim.status).toBe(200);
    expect(sim.body.expandedMoves).toBe(2);
    expect(
      sim.body.territories.find((/** @type {any} */ t) => t.territoryId === f.a)
        .before.travelMinutes,
    ).toBe(40);
    expect(calls).toBeGreaterThan(0);
    available = false;
    const fallback = await f.call("/simulate", body);
    expect(fallback.status).toBe(200);
    expect(fallback.body.territories[0].before.travelSource).toContain(
      "SAMPLE",
    );
    available = true;
    const saved = await f.call("/save", {
      ...body,
      name: "SAMPLE move whole beat",
      effectiveOn: f.day,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(saved.status).toBe(200);
    expect(
      (
        await f.call("/publish", {
          scenarioId: saved.body.id,
          contentHash: saved.body.contentHash,
        })
      ).status,
    ).toBe(403);
    const published = await f.call(
      "/publish",
      { scenarioId: saved.body.id, contentHash: saved.body.contentHash },
      1,
    );
    expect(published.status).toBe(200);
    expect(published.body.assignments).toBe(2);
    const future = await f.h
      .db`select outlet_id,territory_id,route_id,sequence from outlet_assignments where route_id=${f.route} and effective_from=${new Date(f.day + "T00:00:00+08:00")} and (effective_to is null or effective_to>effective_from) order by sequence`;
    expect(future.map((/** @type {any} */ r) => r.outlet_id)).toEqual(
      f.stores.slice(0, 2),
    );
    expect(future.every((/** @type {any} */ r) => r.territory_id === f.b)).toBe(
      true,
    );
    expect(future.map((/** @type {any} */ r) => r.sequence)).toEqual([1, 2]);
    const read = await f.call("");
    expect(read.status).toBe(200);
    expect(read.body.scenarios[0].plan.routeMoves).toHaveLength(1);
  } finally {
    await f.h.close();
    provider.stop(true);
  }
});
test("F-224 boundary pins drive scoped store changes and canonical geometry applies only at the effective day", async () => {
  const f = await fixture({}, "admin");
  try {
    const polygon = (/** @type {number} */ lo, /** @type {number} */ hi) =>
      geometry({
        type: "Polygon",
        coordinates: [
          [
            [lo, 9.9],
            [hi, 9.9],
            [hi, 10.4],
            [lo, 10.4],
            [lo, 9.9],
          ],
        ],
      });
    const a = polygon(122.9, 123.05),
      b = polygon(123.05, 123.4);
    expect(contains(a, [123, 10])).toBe(true);
    expect(contains(a, [123.1, 10.1])).toBe(false);
    expect(() =>
      geometry({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 2],
          ],
        ],
      }),
    ).toThrow();
    const body = {
      moves: [],
      plan: {
        boundaries: [
          { territoryId: f.a, geoJson: a },
          { territoryId: f.b, geoJson: b },
        ],
        routingMode: "estimate",
      },
    };
    const sim = await f.call("/simulate", body);
    expect(sim.status).toBe(200);
    expect(sim.body.expandedMoves).toBe(1);
    const saved = await f.call("/save", {
      ...body,
      name: "SAMPLE boundary review",
      effectiveOn: f.day,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(saved.status).toBe(200);
    const published = await f.call(
      "/publish",
      { scenarioId: saved.body.id, contentHash: saved.body.contentHash },
      1,
    );
    expect(published.status).toBe(200);
    expect(
      (
        await f.h.db`select boundary_geo_json from territories where id=${f.b}`
      )[0].boundary_geo_json,
    ).toBe(null);
    const at = Date.parse(f.day + "T00:00:00+08:00");
    await expect(
      applyScenarioBoundaries(f.h.db, saved.body.id, at - 1),
    ).rejects.toThrow();
    await applyScenarioBoundaries(f.h.db, saved.body.id, at);
    await applyScenarioBoundaries(f.h.db, saved.body.id, at);
    expect(
      JSON.parse(
        (
          await f.h
            .db`select boundary_geo_json from territories where id=${f.b}`
        )[0].boundary_geo_json,
      ),
    ).toEqual(b);
    const read = await f.call("");
    expect(read.body.scenarios[0].plan.boundaryStatus).toBe("applied");
    expect(
      (
        await f.h
          .db`select count(*)::int n from jobs where kind='coverage.scenarioBoundaries' and payload->>'scenarioId'=${saved.body.id}`
      )[0].n,
    ).toBe(1);
    if (process.env.SP_SCENARIO_WIRE)
      await Bun.write(
        process.env.SP_SCENARIO_WIRE,
        JSON.stringify({ simulation: sim.body, book: read.body }),
      );
  } finally {
    await f.h.close();
  }
});
