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

// Loosened (jc): SP-0205's owner-hierarchy filter is gone. Add salesperson lists every
// active person, whatever their branch, and any of them can be saved.
const activeIds = () => [
  ids.outsider,
  ids.child,
  ids.owner,
  ids.unassigned,
  ids.moved,
  ids.ended,
  ids.movedIn,
];

test("loosened rule 1: the picker lists every active person, not only the owner's branch", async () => {
  const result = await call(options(territory, { paginationOpts: JSON.stringify({ numItems: 50, cursor: null }) }));
  expect(result.status).toBe(200);
  const listed = result.body.page.map((/** @type {any} */ p) => p._id);
  for (const id of activeIds()) expect(listed).toContain(id);
  expect(listed).not.toContain(ids.disabled);
  const search = await call(options(territory, { q: "Sibling" }));
  expect(search.body.page.map((/** @type {any} */ p) => p._id)).toContain(
    ids.outsider,
  );
});

test("loosened rule 1: a territory without an owner still lists active people", async () => {
  const [row] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by)
    values('sunpride','NO_OWNER','No owner','active',now()-interval '1 day','system:test') returning id`;
  const result = await call(options(row.id));
  expect(result.status).toBe(200);
  expect(
    result.body.page.some((/** @type {any} */ p) => p._id === ids.outsider),
  ).toBe(true);
});

test("the picker keeps its permission checks", async () => {
  expect((await call(options(), siblingAdminCookie)).status).toBe(200);
  expect((await call(options(), readerCookie)).status).toBe(403);
  expect((await call(options(), "")).status).toBe(401);
  expect((await call(options("not-a-uuid"))).status).toBe(400);
});

test("loosened rule 1: a person from another branch is saved as the territory's salesperson", async () => {
  const effectiveFrom = Date.now() + 60000;
  const outside = await call("territories/assignSalesperson", bossCookie, {
    territoryId: territory,
    kind: "primary",
    effectiveFrom,
    reason: "Picker proof",
    profileId: ids.outsider,
  });
  expect(outside.status, JSON.stringify(outside.body)).toBe(200);
  const stored = await call(
    `territories/salespeople-at?territoryId=${territory}&asOf=${effectiveFrom}`,
  );
  expect(stored.status).toBe(200);
  expect(stored.body).toHaveLength(1);
  expect(stored.body[0]).toMatchObject({
    profileId: ids.outsider,
    personName: "Sibling salesperson",
    kind: "primary",
  });
});
