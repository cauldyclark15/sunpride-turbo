import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb } from "@sunpride/db/client";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { identityHooks, ORG_LOCK } from "../src/domains/org/identity.js";
import { actorFor } from "../src/core/context.js";

// SP-0169 orglock: ORG_LOCK guards identity writes (provisioning, linking, SP-0168
// invitation acceptance). An already-linked user's authenticated request only reads and
// must not queue behind it, or one stalled transaction blocks every sign-in and all
// requests in the org are serialized.

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let holder;
const password = "test-only-orglock-horse";
/** @type {{ userId: string, cookie: string }[]} */ const linked = [];

/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => /** @type {const} */ ("hung"))]);

/** Hold ORG_LOCK in an open transaction on a separate connection (a stalled org write). */
async function holdOrgLock() {
  /** @type {() => void} */ let release = () => {};
  const gate = new Promise((r) => (release = () => r(undefined)));
  /** @type {() => void} */ let held = () => {};
  const isHeld = new Promise((r) => (held = () => r(undefined)));
  const done = holder.begin(async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
    held();
    await gate;
  });
  await isHeld;
  return { release: async () => (release(), await done) };
}

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  holder = createDb(h.dbUrl, { max: 1 });
  for (let i = 0; i < 6; i++) {
    const email = `linked-${i}-${crypto.randomUUID()}@example.com`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},${await Bun.password.hash(password)}) returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,effective_from) values(${u.id},${u.id},${"Linked " + i},${email},'viewer','active',now()-interval '1 day') returning id`;
    await h.db`insert into employee_assignments(profile_id,role,effective_from,actor_subject,reason) values(${p.id},'viewer',now()-interval '1 day','system:test','fixture')`;
    const res = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    linked.push({
      userId: u.id,
      cookie: String(res.headers.get("set-cookie")).split(";")[0],
    });
  }
}, 120_000);
afterAll(async () => {
  await holder?.close();
  await h?.close();
});

test("a stalled transaction holding ORG_LOCK does not block linked users' authenticated requests", async () => {
  const lock = await holdOrgLock();
  try {
    const started = Date.now();
    const statuses = await within(
      Promise.all(
        linked.map(async (u) => {
          const res = await h.fetch("/api/me", {
            headers: { cookie: u.cookie },
          });
          await res.text();
          return res.status;
        }),
      ),
      5_000,
    );
    expect(statuses).toEqual(linked.map(() => 200));
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    await lock.release();
  }
});

test("actorFor inside a caller's transaction leaves no ORG_LOCK held until that commit", async () => {
  await h.db.begin(async (/** @type {any} */ t) => {
    t.__inTx = true;
    const actor = await actorFor(t, linked[0].userId);
    expect(actor?.userId).toBe(linked[0].userId);
    // Another connection can take the exclusive lock right now.
    const [r] = await holder`select pg_try_advisory_lock(${ORG_LOCK}) as ok`;
    expect(r.ok).toBe(true);
    await holder`select pg_advisory_unlock(${ORG_LOCK})`;
  });
});

test("the write path still takes ORG_LOCK: a first sign-in waits for a held lock", async () => {
  const email = `wait-${crypto.randomUUID()}@example.com`;
  await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at) values(${email},'Waiter','sales','pending','system:test',now())`;
  const [u] =
    await h.db`insert into users(email,password_hash) values(${email},'x') returning id`;
  const hooks = identityHooks(h.env);
  const lock = await holdOrgLock();
  const pending = hooks.loadProfile(h.db, u.id);
  expect(await within(pending, 500)).toBe("hung");
  await lock.release();
  const profile = await pending;
  expect(profile?.role).toBe("sales");
});

test("two simultaneous first sign-ins for the same invited email produce one profile", async () => {
  const hooks = identityHooks(h.env);
  for (let round = 0; round < 5; round++) {
    const email = `race-${round}-${crypto.randomUUID()}@example.com`;
    await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at) values(${email},'Racer','sales','pending','system:test',now())`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},'x') returning id`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => hooks.loadProfile(h.db, u.id)),
    );
    const ids = new Set(results.map((r) => r?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    const [n] =
      await h.db`select count(*)::int as n from profiles where lower(email)=${email}`;
    expect(n.n).toBe(1);
    const [a] =
      await h.db`select count(*)::int as n from employee_assignments where profile_id=${results[0]?.id}`;
    expect(a.n).toBe(1);
    const [inv] =
      await h.db`select status,profile_id from access_invitations where email=${email}`;
    expect(inv).toEqual({ status: "accepted", profile_id: results[0]?.id });
  }
});

test("SP-0168 race: concurrent first sign-ins of a pre-provisioned profile link and accept once", async () => {
  const hooks = identityHooks(h.env);
  const email = `pre-${crypto.randomUUID()}@example.com`;
  const [p] =
    await h.db`insert into profiles(name,email,role,status,effective_from) values('Pre',${email},'manager','active',now()-interval '1 day') returning id`;
  await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at) values(${email},'Pre','manager','pending','system:test',now())`;
  const [u] =
    await h.db`insert into users(email,password_hash) values(${email},'x') returning id`;
  const results = await Promise.all(
    Array.from({ length: 4 }, () => hooks.loadProfile(h.db, u.id)),
  );
  expect(results.map((r) => r?.id)).toEqual(results.map(() => p.id));
  const [row] = await h.db`select user_id from profiles where id=${p.id}`;
  expect(row.user_id).toBe(u.id);
  const [inv] =
    await h.db`select status,profile_id from access_invitations where email=${email}`;
  expect(inv).toEqual({ status: "accepted", profile_id: p.id });
});
