import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/org/index.js";

// SP-0235: real authenticated HTTP reads against the lane's disposable PostgreSQL
// harness. Fixture invitations are inserted directly; no invitation mail is sent.
/** @type {import('./harness.js').Harness} */ let h;
let boss = "";
let admin = "";
let salesperson = "";
const password = "invitation-search-test-only";
const fixtures = [
  { name: "Grace Lim", email: "first@example.test", status: "pending" },
  { name: "Joel Tan", email: "second@example.test", status: "pending" },
  {
    name: "Marisol Del Rosario",
    email: "worker03@example.test",
    status: "pending",
  },
  {
    name: "Andres Del Rosario",
    email: "worker04@example.test",
    status: "accepted",
  },
  {
    name: "Elena Del Rosario",
    email: "worker05@example.test",
    status: "revoked",
  },
  { name: null, email: "legacy.person@example.test", status: "pending" },
  {
    name: "Percent%_\\ Match",
    email: "literal@example.test",
    status: "pending",
  },
  { name: "PercentXYZ Match", email: "decoy@example.test", status: "pending" },
];
const id = (/** @type {number} */ index) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

/** @param {string} email */
async function signIn(email) {
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** @param {Record<string, any>} [params] @param {string} [cookie] */
async function search(params = {}, cookie = boss) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    query.set(key, typeof value === "object" ? JSON.stringify(value) : value);
  const res = await h.fetch(`/api/v1/people/invitations/list?${query}`, {
    headers: { cookie },
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  const hash = await Bun.password.hash(password);
  await h.db`insert into users(email,password_hash) values('boss@example.com',${hash})`;
  boss = await signIn("boss@example.com");
  const me = await h.fetch("/api/me", { headers: { cookie: boss } });
  expect(me.status).toBe(200);
  const root = /** @type {any} */ (await me.json()).profile.orgUnitId;
  for (const role of ["admin", "sales"]) {
    const email = `${role}@example.test`;
    const [user] =
      await h.db`insert into users(email,password_hash) values(${email},${hash}) returning id`;
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)
      values(${user.id},${user.id},${role},${email},${role},'active',${root})`;
    if (role === "admin") admin = await signIn(email);
    else salesperson = await signIn(email);
  }
  for (const [index, fixture] of fixtures.entries())
    await h.db`insert into access_invitations(id,email,name,role,status,invited_by,invited_at)
      values(${id(index)},${fixture.email},${fixture.name},'sales',${fixture.status},'test:sp235',now())`;
}, 30000);

afterAll(async () => {
  await h?.close();
});

test("SP-0235 finds full and partial names independently of email, ignoring case and outer spaces", async () => {
  for (const q of ["Marisol", "arisol", "Marisol Del Rosario", "  MARISOL  "]) {
    const result = await search({ q });
    expect(result.status).toBe(200);
    expect(result.body.page.map((/** @type {any} */ row) => row._id)).toEqual([
      id(2),
    ]);
    expect(result.body.page[0].name).toBe("Marisol Del Rosario");
  }
  const surname = await search({ q: "DEL ROSARIO" }, admin);
  expect(surname.status).toBe(200);
  expect(surname.body.page.map((/** @type {any} */ row) => row._id)).toEqual([
    id(2),
    id(3),
    id(4),
  ]);
});

test("SP-0235 preserves email-only searches, including invitations without a name", async () => {
  for (const [q, index] of [
    ["WORKER03", 2],
    ["legacy.person", 5],
  ]) {
    const result = await search({ q });
    expect(result.status).toBe(200);
    expect(result.body.page.map((/** @type {any} */ row) => row._id)).toEqual([
      id(Number(index)),
    ]);
  }
});

test("SP-0235 filters names before paging and retains the same search on later pages", async () => {
  const first = await search({
    q: "Del Rosario",
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(first.status).toBe(200);
  expect(first.body.page.map((/** @type {any} */ row) => row._id)).toEqual([
    id(2),
    id(3),
  ]);
  expect(first.body.isDone).toBe(false);
  expect(first.body.continueCursor).toBe(id(3));
  const second = await search({
    q: "Del Rosario",
    paginationOpts: { numItems: 2, cursor: first.body.continueCursor },
  });
  expect(second.status).toBe(200);
  expect(second.body.page.map((/** @type {any} */ row) => row._id)).toEqual([
    id(4),
  ]);
  expect(second.body.isDone).toBe(true);
  expect(second.body.continueCursor).toBe("");
});

test("SP-0235 combines name matches with status rather than letting either bypass it", async () => {
  const result = await search({ q: "Del Rosario", status: "accepted" });
  expect(result.status).toBe(200);
  expect(result.body.page.map((/** @type {any} */ row) => row._id)).toEqual([
    id(3),
  ]);
});

test("SP-0235 treats wildcard and quote characters literally and restores the list when cleared", async () => {
  const literal = await search({ q: "%_\\" });
  expect(literal.status).toBe(200);
  expect(literal.body.page.map((/** @type {any} */ row) => row._id)).toEqual([
    id(6),
  ]);
  for (const q of ["Nobody matches", "' OR true --"]) {
    const empty = await search({ q });
    expect(empty.status).toBe(200);
    expect(empty.body.page).toEqual([]);
    expect(empty.body.isDone).toBe(true);
  }
  for (const params of [{}, { q: "" }, { q: "   " }]) {
    const all = await search(params);
    expect(all.status).toBe(200);
    expect(all.body.page.map((/** @type {any} */ row) => row._id)).toEqual(
      fixtures.map((_, index) => id(index)),
    );
  }
});

test("SP-0235 does not grant invitation search to anonymous callers or salespeople", async () => {
  expect((await search({ q: "Marisol" }, "")).status).toBe(401);
  expect((await search({ q: "Marisol" }, salesperson)).status).toBe(403);
});
