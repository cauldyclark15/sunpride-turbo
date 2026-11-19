import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { install } from "../src/domains/org/index.js";

/** @type {import('./harness.js').Harness} */
let h;
let bossCookie = "";
let siblingAdminCookie = "";
let readerCookie = "";
let root = "";
let owner = "";
let child = "";
let sibling = "";
let territory = "";
const ids = {
  outsider: "00000000-0000-4000-8000-000000000001",
  child: "00000000-0000-4000-8000-000000000002",
  owner: "00000000-0000-4000-8000-000000000003",
  disabled: "00000000-0000-4000-8000-000000000004",
  unassigned: "00000000-0000-4000-8000-000000000005",
  moved: "00000000-0000-4000-8000-000000000006",
  ended: "00000000-0000-4000-8000-000000000007",
  movedIn: "00000000-0000-4000-8000-000000000008",
};
const password = "territory-picker-test-only";

/** @param {string} path @param {string} [cookie] @param {any} [body] */
async function call(path, cookie = bossCookie, body) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} email */
async function signIn(email) {
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}
/** @param {string} code @param {string} parent */
async function unit(code, parent) {
  const [row] =
    await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from)
    values('sunpride',${code},${code},'REGION',${parent},'active',now()-interval '1 day') returning id`;
  await h.db`insert into org_unit_parent_edges(unit_id,parent_id,effective_from,actor_subject,reason)
    values(${row.id},${parent},now()-interval '1 day','system:test','fixture')`;
  return /** @type {string} */ (row.id);
}
/** @param {string} id @param {string} name @param {string|null} projected @param {string|null} [effective] @param {string} [status] */
async function person(
  id,
  name,
  projected,
  effective = projected,
  status = "active",
) {
  await h.db`insert into profiles(id,name,email,role,status,org_unit_id,effective_from)
    values(${id},${name},${`${id}@example.test`},'sales',${status},${projected},now()-interval '1 day')`;
  if (effective)
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
      values(${id},${effective},'sales',now()-interval '1 day','system:test','fixture')`;
}
/** @param {string} email @param {string} role @param {string} unitId */
async function staff(email, role, unitId) {
  const userId = await createUser(h, email, password);
  await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from)
    values(${userId},${userId},${email},${email},${role},'active',${unitId},now()-interval '1 day')`;
  return signIn(email);
}
/** @param {string} id @param {Record<string,unknown>} [params] */
function options(id = territory, params = {}) {
  return `people/list?${new URLSearchParams({ territoryId: id, ...params }).toString()}`;
}

beforeAll(async () => {
  h = await startHarness({ installers: [install], port: 5000 });
  await createUser(h, "boss@example.com", password);
  bossCookie = await signIn("boss@example.com");
  const me = await h.fetch("/api/me", { headers: { cookie: bossCookie } });
  const body = /** @type {any} */ (await me.json());
  expect(me.status).toBe(200);
  root = body.profile.orgUnitId;
  await h.db`update org_units set effective_from=now()-interval '2 days' where id=${root}`;
  owner = await unit("PICKER_OWNER", root);
  child = await unit("PICKER_CHILD", owner);
  sibling = await unit("PICKER_SIBLING", root);
  const [row] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by)
    values('sunpride','PICKER','Picker territory','active',now()-interval '1 day','system:test') returning id`;
  territory = row.id;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason)
    values(${territory},${owner},now()-interval '1 day','system:test','fixture')`;
  await person(ids.outsider, "Sibling salesperson", sibling);
  await person(ids.child, "Child salesperson", child);
  await person(ids.owner, "Owner salesperson", owner);
  await person(ids.disabled, "Disabled salesperson", owner, owner, "disabled");
  await person(ids.unassigned, "Unassigned salesperson", null);
  await person(ids.moved, "Moved out salesperson", owner, sibling);
  await person(ids.ended, "Ended salesperson", owner);
  await h.db`update employee_assignments set effective_to=now()-interval '1 hour' where profile_id=${ids.ended}`;
  await person(ids.movedIn, "Moved in salesperson", sibling, owner);
  siblingAdminCookie = await staff(
    "sibling-admin@example.test",
    "admin",
    sibling,
  );
  readerCookie = await staff("reader@example.test", "manager", root);
}, 30000);

afterAll(async () => {
  await h?.close();
});

test("SP-0205: the owner's current hierarchy filters active people, not the administrator's wider scope or stale profile units", async () => {
  const result = await call(options());
  expect(result.status).toBe(200);
  expect(result.body.page.map((/** @type {any} */ p) => p._id)).toEqual([
    ids.child,
    ids.owner,
    ids.movedIn,
  ]);
  expect(result.body.page.map((/** @type {any} */ p) => p.orgUnitId)).toEqual([
    child,
    owner,
    owner,
  ]);
  // The ordinary People screen keeps its existing company-wide behavior.
  const ordinary = await call("people/list");
  expect(ordinary.status).toBe(200);
  expect(
    ordinary.body.page.some((/** @type {any} */ p) => p._id === ids.outsider),
  ).toBe(true);
});

test("SP-0205: filtering precedes pagination and scoped search", async () => {
  const first = await call(
    options(territory, {
      paginationOpts: JSON.stringify({ numItems: 1, cursor: null }),
    }),
  );
  expect(first.status).toBe(200);
  expect(first.body.page.map((/** @type {any} */ p) => p._id)).toEqual([
    ids.child,
  ]);
  expect(first.body.isDone).toBe(false);
  const next = await call(
    options(territory, {
      paginationOpts: JSON.stringify({
        numItems: 1,
        cursor: first.body.continueCursor,
      }),
    }),
  );
  expect(next.body.page.map((/** @type {any} */ p) => p._id)).toEqual([
    ids.owner,
  ]);
  const last = await call(
    options(territory, {
      paginationOpts: JSON.stringify({
        numItems: 1,
        cursor: next.body.continueCursor,
      }),
    }),
  );
  expect(last.body.page.map((/** @type {any} */ p) => p._id)).toEqual([
    ids.movedIn,
  ]);
  expect(last.body.isDone).toBe(true);
  const search = await call(options(territory, { q: "Moved" }));
  expect(search.body.page.map((/** @type {any} */ p) => p._id)).toEqual([
    ids.movedIn,
  ]);
  expect((await call(options(territory, { q: "Sibling" }))).body.page).toEqual(
    [],
  );
});

test("SP-0205: missing ownership returns no choices instead of a company-wide list", async () => {
  const [row] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by)
    values('sunpride','NO_OWNER','No owner','active',now()-interval '1 day','system:test') returning id`;
  const result = await call(options(row.id));
  expect(result.status).toBe(200);
  expect(result.body.page).toEqual([]);
  expect(result.body.isDone).toBe(true);
});

test("SP-0205: a future territory uses its starting owner, not every person", async () => {
  const [row] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by)
    values('sunpride','FUTURE_OWNER','Future territory','active',now()+interval '1 day','system:test') returning id`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason)
    values(${row.id},${owner},now()+interval '1 day','system:test','fixture')`;
  const result = await call(options(row.id));
  expect(result.status).toBe(200);
  expect(result.body.page.map((/** @type {any} */ p) => p._id)).toEqual([
    ids.child,
    ids.owner,
    ids.movedIn,
  ]);
});

test("SP-0205: filtered options retain current territory and people permissions", async () => {
  expect((await call(options(), siblingAdminCookie)).status).toBe(403);
  expect((await call(options(), readerCookie)).status).toBe(403);
  expect((await call(options(), "")).status).toBe(401);
  expect((await call(options("not-a-uuid"))).status).toBe(400);
});

test("SP-0205: an eligible child-unit selection saves; an outsider is still refused without creating an assignment", async () => {
  const effectiveFrom = Date.now() + 60000;
  const payload = {
    territoryId: territory,
    kind: "primary",
    effectiveFrom,
    reason: "Picker proof",
  };
  const outside = await call("territories/assignSalesperson", bossCookie, {
    ...payload,
    profileId: ids.outsider,
  });
  expect(outside.status).toBe(422);
  expect(outside.body.error.message).toContain(
    "Person outside owner hierarchy",
  );
  const before =
    await h.db`select id from territory_salespeople where territory_id=${territory}`;
  expect(before).toHaveLength(0);
  const saved = await call("territories/assignSalesperson", bossCookie, {
    ...payload,
    profileId: ids.child,
  });
  expect(saved.status).toBe(200);
  const stored = await call(
    `territories/salespeople-at?territoryId=${territory}&asOf=${effectiveFrom}`,
  );
  expect(stored.status).toBe(200);
  expect(stored.body).toHaveLength(1);
  expect(stored.body[0]).toMatchObject({
    profileId: ids.child,
    personName: "Child salesperson",
    kind: "primary",
  });
});

test("SP-0205: changing the effective date follows scheduled person and territory ownership changes", async () => {
  const changeAt = Date.now() + 86400000;
  const asOf = changeAt + 86400000;
  const scheduled = "00000000-0000-4000-8000-000000000009";
  await person(scheduled, "Scheduled salesperson", owner);
  await h.db`update employee_assignments set effective_to=${new Date(changeAt)} where profile_id=${scheduled}`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
    values(${scheduled},${sibling},'sales',${new Date(changeAt)},'system:test','fixture')`;
  const current = await call(
    options(territory, { q: "Scheduled", asOf: String(Date.now()) }),
  );
  expect(current.status).toBe(200);
  expect(current.body.page.map((/** @type {any} */ p) => p._id)).toEqual([
    scheduled,
  ]);
  const afterMove = await call(
    options(territory, { q: "Scheduled", asOf: String(asOf) }),
  );
  expect(afterMove.status).toBe(200);
  expect(afterMove.body.page).toEqual([]);

  const [row] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by)
    values('sunpride','TRANSFER_OWNER','Transferred territory','active',now()-interval '1 day','system:test') returning id`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,effective_to,actor_subject,reason)
    values(${row.id},${owner},now()-interval '1 day',${new Date(changeAt)},'system:test','fixture')`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason)
    values(${row.id},${sibling},${new Date(changeAt)},'system:test','fixture')`;
  const afterTransfer = await call(
    options(row.id, { q: "Scheduled", asOf: String(asOf) }),
  );
  expect(afterTransfer.status).toBe(200);
  expect(afterTransfer.body.page).toHaveLength(1);
  expect(afterTransfer.body.page[0]).toMatchObject({
    _id: scheduled,
    orgUnitId: sibling,
  });
  // Future ownership does not grant access when the current territory is outside the caller's scope.
  expect(
    (await call(options(row.id, { asOf: String(asOf) }), siblingAdminCookie))
      .status,
  ).toBe(403);
  const saved = await call("territories/assignSalesperson", bossCookie, {
    territoryId: row.id,
    profileId: scheduled,
    kind: "primary",
    effectiveFrom: asOf,
    reason: "Scheduled picker proof",
  });
  expect(saved.status).toBe(200);
  const stored = await call(
    `territories/salespeople-at?territoryId=${row.id}&asOf=${asOf}`,
  );
  expect(stored.body).toHaveLength(1);
  expect(stored.body[0].profileId).toBe(scheduled);
});
