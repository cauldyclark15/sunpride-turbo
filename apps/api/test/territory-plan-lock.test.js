// SP-0222: office can add stores to territories/groups while an approved plan runs;
// only changes that pull a planned store out of its plan's territory are refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { loadPhGeography } from "../../../packages/db/src/ph-geography.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let root;
/** @type {any} */ let cookie;
/** @type {any} */ let profile;
/** @type {any} */ let cebu;
/** @type {any} */ let mandaue;
/** @type {any} */ let territoryId;
/** @type {any[]} */ const stores = [];
/** @param {string} path @param {any} [body] */
async function call(path, body) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} id */
async function current(id) {
  const [row] =
    await h.db`select territory_id from outlet_assignments where outlet_id=${id} and deleted_at is null and effective_from<=clock_timestamp() and (effective_to is null or effective_to>clock_timestamp())`;
  return row?.territory_id ?? null;
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  await loadPhGeography(h.db);
  await h.db`insert into users(email,password_hash) values('boss@example.com',${await Bun.password.hash("test-only-password")})`;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "boss@example.com",
      password: "test-only-password",
    }),
  });
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const me = /** @type {any} */ (
    await (await h.fetch("/api/me", { headers: { cookie } })).json()
  );
  root = me.profile.orgUnitId;
  profile = me.profile.id;
  await h.db`update profiles set name='Juan Salesman' where id=${profile}`;
  await h.db`update org_units set effective_from=now()-interval '1 day' where id=${root}`;
  [cebu] =
    await h.db`select * from ph_municipalities where name='City of Cebu'`;
  [mandaue] =
    await h.db`select * from ph_municipalities where name='City of Mandaue'`;
  for (const [i, place] of [cebu, mandaue, mandaue].entries()) {
    const [store] =
      await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride',${`LOCK-${i}`},${`SAMPLE lock store ${i}`},${root},'active','test') returning *`;
    await h.db`insert into customer_profiles(outlet_id,municipality_code,updated_by) values(${store.id},${place.code},'test')`;
    stores.push(store);
  }
  const t = await call("territories/create", {
    code: "LOCK-T",
    name: "SAMPLE Cebu North",
    orgUnitId: root,
    effectiveFrom: Date.now(),
    reason: "fixture",
    territoryType: "location",
    municipalityCodes: [cebu.code],
  });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  territoryId = t.body;
  expect(await current(stores[0].id)).toBe(territoryId);
  // Juan's approved plan for this month covers store 0 in this territory.
  const [plan] =
    await h.db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,content_revision,created_by,updated_by)
    values('sunpride',${profile},'2026-11',1,'monthly',${root},now()-interval '1 day',now()+interval '20 days',now()-interval '1 day',now()+interval '20 days','approved','test',now(),1,'test','test') returning id`;
  await h.db`insert into coverage_plan_outlets(plan_id,outlet_id,territory_id,frequency,priority,expected_duration_minutes,content_revision,updated_by) values(${plan.id},${stores[0].id},${territoryId},'monthly',1,10,1,'test')`;
}, 30000);
afterAll(async () => {
  if (h) await h.close();
});

const edit = (/** @type {any} */ fields) =>
  call("territories/edit", {
    territoryId,
    name: "SAMPLE Cebu North",
    territoryType: "location",
    reason: "SP-0222 office change",
    ...fields,
  });

test("store search on the pickers matches name, code and territory, not the address province", async () => {
  await h.db`update outlets set address='Sample address, Mandaue, Cebu' where code like 'LOCK-%'`;
  const list = async (/** @type {string} */ q, store = true) =>
    (
      await call(
        `outlets/list?q=${encodeURIComponent(q)}${store ? "&searchIn=store" : ""}&status=active`,
      )
    ).body.page.map((/** @type {any} */ r) => r.code);
  expect((await list("Cebu", false)).length).toBe(3);
  expect(await list("Cebu North")).toEqual(["LOCK-0"]);
  expect(await list("lock store 2")).toEqual(["LOCK-2"]);
  expect(await list("LOCK-1")).toEqual(["LOCK-1"]);
  expect(await list("Nowhere")).toEqual([]);
});

test("adding a place to a territory with an approved plan is allowed", async () => {
  const r = await edit({ municipalityCodes: [cebu.code, mandaue.code] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await current(stores[1].id)).toBe(territoryId);
  expect(await current(stores[0].id)).toBe(territoryId);
});

test("removing an unplanned store's place is allowed", async () => {
  const r = await edit({ municipalityCodes: [cebu.code] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await current(stores[1].id)).toBe(null);
});

test("removing a planned store is refused in plain words naming plan, salesman and day, with no partial write", async () => {
  const r = await edit({ municipalityCodes: [mandaue.code] });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe("plan_locked");
  const msg = r.body.error.message;
  expect(msg).toContain("SAMPLE lock store 0");
  expect(msg).toContain("Juan Salesman");
  expect(msg).toContain("November 2026");
  expect(msg).toContain("SAMPLE Cebu North");
  expect(msg).toMatch(/on or after \w+ \d+, \d{4}/);
  expect(msg).not.toContain("interval");
  expect(await current(stores[0].id)).toBe(territoryId);
  const rows =
    await h.db`select municipality_code from territory_coverage where territory_id=${territoryId}`;
  expect(rows.map((/** @type {any} */ x) => x.municipality_code)).toEqual([
    cebu.code,
  ]);
});

test("linking stores to a customer group is allowed, including a planned store that stays in its territory", async () => {
  const g = await call("customer-groups/save", {
    code: "LOCKGRP",
    name: "SAMPLE Lock group",
    reason: "fixture",
  });
  expect(g.status).toBe(200);
  const r = await call("customer-groups/link-stores", {
    customerGroupId: g.body,
    outletIds: [stores[0].id, stores[2].id],
    reason: "Group setup",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await current(stores[0].id)).toBe(territoryId);
  // A group territory would now pull store 0 away from Juan's plan: refused.
  const t = await call("territories/create", {
    code: "LOCK-G",
    name: "SAMPLE Group territory",
    orgUnitId: root,
    effectiveFrom: Date.now(),
    reason: "fixture",
    territoryType: "customer_group",
    customerGroupIds: [g.body],
  });
  expect(t.status).toBe(422);
  expect(t.body.error.code).toBe("plan_locked");
  expect(await current(stores[0].id)).toBe(territoryId);
});

test("after the plan ends the same removal is allowed", async () => {
  await h.db`update coverage_plans set effective_to=now()-interval '1 second'`;
  const r = await edit({ municipalityCodes: [mandaue.code] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
