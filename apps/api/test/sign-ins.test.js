import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { createAccess, createSession } from "../src/core/auth.js";
import { sha256Hex } from "../src/core/util.js";
import { signInDay } from "../src/domains/org/sign-ins.js";
import { manilaBusinessDate } from "../src/core/docnum.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {Record<string,any>} */ const f = {};
const DAY = "2026-11-17";
const START = Date.parse(`${DAY}T00:00:00+08:00`);
/** @param {string} name @param {string} role @param {string|null} unit @param {string} [status] */
async function person(name, role, unit, status = "active") {
  const id = crypto.randomUUID();
  const [u] =
    await h.db`insert into users(email,password_hash) values(${`${id}@example.test`},'unused-test-only') returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,created_at)
    values(${u.id},${u.id},${name},${`${id}@example.test`},${role},${status},${unit},'2020-01-01') returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
    values(${p.id},${unit},${role},'2020-01-01','test','SAMPLE sign-ins proof')`;
  const s = await createSession(h.db, u.id, "web", null);
  return {
    id: p.id,
    userId: u.id,
    cookie: `sp_session=${s.token}`,
    sessionId: s.id,
    token: s.token,
  };
}
/** @param {any} p @param {string} app @param {number} created @param {number|null} seen */
async function signin(p, app, created, seen) {
  const [s] =
    await h.db`insert into sessions(token_hash,user_id,app,created_at,expires_at,revoked_at,last_seen_at)
    values(${sha256Hex(crypto.randomUUID())},${p.userId},${app},${new Date(created)},${new Date(created + 3600000)},${new Date(created + 3600000)},${seen === null ? null : new Date(seen)}) returning id`;
  return s.id;
}
/** @param {any} actor @param {Record<string,string>} [filters] */
async function report(actor = f.owner, filters = { date: DAY }) {
  const res = await h.fetch(
    `/api/v1/people/sign-ins?${new URLSearchParams(filters)}`,
    { headers: actor ? { cookie: actor.cookie } : {} },
  );
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
beforeAll(async () => {
  h = await startHarness({
    installers: [install],
    port: Number(process.env.SP_TEST_PORT ?? 5000),
  });
  f.root = await ensureRoot(h.db);
  await h.db`update org_units set effective_from='2020-01-01' where id=${f.root}`;
  for (const [code, parent] of [
    ["A", f.root],
    ["CHILD", "A"],
    ["OTHER", f.root],
  ]) {
    const [u] =
      await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from)
      values('sunpride',${code},${`SAMPLE ${code}`},'REGION',${f[parent] ?? parent},'active','2020-01-01') returning id`;
    f[code] = u.id;
  }
  f.owner = await person("Owner", "super_admin", f.root);
  f.admin = await person("Admin", "admin", f.A);
  f.manager = await person("Manager", "manager", f.A);
  f.rep = await person("Ana", "sales", f.A);
  f.child = await person("Ben", "sales", f.CHILD);
  f.other = await person("Foreign", "sales", f.OTHER);
  f.missing = await person("No new login", "sales", f.A);
  f.inactive = await person("Inactive", "sales", f.A, "disabled");
  f.disabled = await person("Disabled", "sales", f.A);
  await h.db`update users set disabled_at=now() where id=${f.disabled.userId}`;
  f.noAccount = crypto.randomUUID();
  await h.db`insert into profiles(id,auth_subject,name,email,role,status,org_unit_id,created_at)
    values(${f.noAccount},'test:no-account','Not yet registered','no-account@example.test','sales','active',${f.A},'2020-01-01')`;
  await signin(f.rep, "web", START, START + 3600000);
  await signin(f.rep, "field-android", START + 7200000, START + 10800000);
  await signin(f.rep, "web", START + 86400000 - 1, null);
  await signin(f.rep, "web", START - 1, START - 1);
  await signin(f.child, "field-ios", START + 1, START + 3600000);
  await signin(f.other, "van-android", START + 2, START + 7200000);
  await signin(f.missing, "field-android", START - 86400000, START + 18000000);
}, 30000);
afterAll(async () => {
  await h?.close();
});

test("Manila date defaults, midnight boundaries and invalid/future dates", () => {
  expect(+signInDay(DAY, START).start).toBe(START);
  expect(+signInDay(DAY, START).end).toBe(START + 86400000);
  expect(signInDay(undefined, START - 1).date).toBe("2026-11-16");
  for (const date of ["2026-02-30", "bad", "2026-11-18", "2026-1-17"])
    expect(() => signInDay(date, START)).toThrow();
});
test("one row per person, all apps, exact count and first/last, even after expiry or sign-out", async () => {
  const r = await report();
  expect(r.status).toBe(200);
  const ana = r.body.signedIn.find(
    (/** @type {any} */ p) => p.profileId === f.rep.id,
  );
  expect(ana).toMatchObject({
    name: "Ana",
    role: "sales",
    branch: "SAMPLE A",
    apps: ["field-android", "web"],
    signIns: 3,
    firstSignInAt: START,
    lastActivityAt: START + 86400000 - 1,
    activityNotRetained: false,
  });
  expect(
    r.body.signedIn.filter((/** @type {any} */ p) => p.profileId === f.rep.id),
  ).toHaveLength(1);
  expect(JSON.stringify(r.body)).not.toMatch(
    /token_hash|password_hash|device_key|sps_|spa_|@example/,
  );
});
// Loosened (jc): managers and admins are company-wide (jc's order; SP-0211 had branch-only).
test("manager sees every branch (loosened, jc)", async () => {
  const r = await report(f.manager);
  expect(r.status).toBe(200);
  expect(r.body.signedIn.map((/** @type {any} */ p) => p.name)).toEqual(expect.arrayContaining(["Ana", "Ben"]));
  expect(r.body.units.map((/** @type {any} */ u) => u.id)).toEqual(
    expect.arrayContaining([f.A, f.CHILD]),
  );
  expect(
    (await report(f.manager, { date: DAY, orgUnitId: f.OTHER })).status,
  ).toBe(/* loosened (jc): was 403 */ 200);
  expect(
    (await report(f.manager, { date: DAY, orgUnitId: f.root })).status,
  ).toBe(/* loosened (jc): was 403 */ 200);
});
test("admin uses the same current branch boundary and owner can read nationwide", async () => {
  expect(
    (await report(f.admin)).body.signedIn.map((/** @type {any} */ p) => p.name),
  ).toEqual(expect.arrayContaining(["Ana", "Ben"]));
  expect(
    (await report()).body.signedIn.map((/** @type {any} */ p) => p.name),
  ).toContain("Foreign");
});
test("branch filter includes descendants; app and role filters affect aggregates and missing list", async () => {
  const r = await report(f.owner, {
    date: DAY,
    orgUnitId: f.A,
    role: "sales",
    app: "web",
  });
  expect(r.status).toBe(200);
  expect(r.body.signedIn).toHaveLength(1);
  expect(r.body.signedIn[0]).toMatchObject({
    name: "Ana",
    signIns: 2,
    apps: ["web"],
  });
  expect(r.body.didNotSignIn.map((/** @type {any} */ p) => p.name)).toContain(
    "Ben",
  );
  const child = await report(f.manager, { date: DAY, orgUnitId: f.CHILD });
  expect(child.body.signedIn.map((/** @type {any} */ p) => p.name)).toEqual([
    "Ben",
  ]);
  expect(
    (await report(f.owner, { date: DAY, role: "admin" })).body.didNotSignIn,
  ).toEqual([]);
});
test("missing list is active sales including unregistered people, not inactive/disabled staff", async () => {
  const r = await report(f.manager);
  expect(r.body.didNotSignIn.map((/** @type {any} */ p) => p.name)).toEqual([
    "No new login",
    "Not yet registered",
  ]);
  expect(r.body.didNotSignIn[0].lastActivityAt).toBe(START + 18000000);
});
test("only the requested roles can read, including direct URL requests", async () => {
  expect((await report(null)).status).toBe(401);
  for (const role of ["sales", "operations", "approver", "analyst", "viewer"]) {
    const p = await person(`denied ${role}`, role, f.root);
    expect((await report(p)).status).toBe(403);
  }
  const unscoped = await person("No branch manager", "manager", null);
  expect((await report(unscoped)).status).toBe(/* loosened (jc): was 403 */ 200);
});
test("invalid date/app/role/branch inputs fail rather than silently widening the report", async () => {
  /** @type {Record<string,string>[]} */
  const inputs = [
    { date: "2026-02-30" },
    { date: "9999-01-01" },
    { date: DAY, app: "bad" },
    { date: DAY, role: "bad" },
    { date: DAY, orgUnitId: "bad" },
  ];
  for (const filters of inputs)
    expect((await report(f.owner, filters)).status).toBe(400);
});
test("company-wide manager still sees a moved person (loosened, jc)", async () => {
  const p = await person("Moved", "sales", f.A);
  await signin(p, "web", START + 100, START + 200);
  await h.db`update employee_assignments set org_unit_id=${f.OTHER} where profile_id=${p.id}`;
  const r = await report(f.manager);
  expect(JSON.stringify(r.body)).toContain("Moved");
  expect(
    (await report()).body.signedIn.find(
      (/** @type {any} */ row) => row.name === "Moved",
    ).branch,
  ).toBe("SAMPLE OTHER");
  await h.db`update employee_assignments set effective_to='2026-01-01' where profile_id=${p.id}`;
  expect((await report(f.manager)).status).toBe(200);
});
test("does not invent historical last activity after a session advances to another day", async () => {
  const p = await person("Later activity", "sales", f.A);
  await signin(p, "web", START + 100, START + 86400000);
  const r = await report();
  expect(
    r.body.signedIn.find(
      (/** @type {any} */ row) => row.name === "Later activity",
    ),
  ).toMatchObject({
    firstSignInAt: START + 100,
    signIns: 1,
    lastActivityAt: null,
    activityNotRetained: true,
  });
});
test("default is today's Manila date and next-midnight sign-ins belong only to the next day", async () => {
  const r = await report(f.owner, {});
  expect(r.body.date).toBe(manilaBusinessDate());
  const p = await person("Next day", "sales", f.A);
  await signin(p, "web", START + 86400000, null);
  expect(
    (await report()).body.signedIn.map((/** @type {any} */ row) => row.name),
  ).not.toContain("Next day");
  expect(
    (await report(f.owner, { date: "2026-11-18" })).body.signedIn.find(
      (/** @type {any} */ row) => row.name === "Next day",
    ).firstSignInAt,
  ).toBe(START + 86400000);
});
test("cookie and native access requests already refresh last_seen_at with a one-minute throttle", async () => {
  const p = await person("Fresh activity", "sales", f.A);
  await h.db`update sessions set last_seen_at=now()-interval '5 minutes' where id=${p.sessionId}`;
  const before = Date.now();
  const a = await h.fetch("/api/me", { headers: { cookie: p.cookie } });
  expect(a.status).toBe(200);
  const [s] =
    await h.db`select last_seen_at from sessions where id=${p.sessionId}`;
  expect(+s.last_seen_at).toBeGreaterThanOrEqual(before - 1000);
  await h.fetch("/api/me", { headers: { cookie: p.cookie } });
  const [same] =
    await h.db`select last_seen_at from sessions where id=${p.sessionId}`;
  expect(+same.last_seen_at).toBe(+s.last_seen_at);
  const native = await createSession(h.db, p.userId, "field-android", null);
  const access = await createAccess(h.db, native.id);
  await h.db`update sessions set last_seen_at=now()-interval '5 minutes' where id=${native.id}`;
  await h.fetch("/api/me", {
    headers: { authorization: `Bearer ${access.token}` },
  });
  const [n] =
    await h.db`select last_seen_at from sessions where id=${native.id}`;
  expect(+n.last_seen_at).toBeGreaterThanOrEqual(before - 1000);
});
