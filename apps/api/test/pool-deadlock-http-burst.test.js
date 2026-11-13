import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb } from "@sunpride/db/client";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { domainInstallers } from "../src/domains/index.js";
import { startHarness } from "./harness.js";

// SP-0169 HTTP burst: the round-5 hang came from mixed traffic (sign-in with its user
// row lock and ORG_LOCK profile transaction, office reads in repeatable-read
// transactions, order approvals with SAP posting, the scheduler) on an exhausted pool.
// The full API composition runs on a pool of 3 with the scheduler on; every request must
// answer, none may leave a transaction idle, and the pool must stay usable.

const PASSWORD = "sp0169-burst-password";
const USERS = ["admin", "manager", "supervisor", "approver", "viewer"];
const ROUNDS = 3;
/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let probe;
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

beforeAll(async () => {
  h = await startHarness({
    installers: domainInstallers,
    poolMax: 3,
    schedule: true,
  });
  await seedDemo(h.db, { anchorDate: today, days: 7 });
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  await h.db`update users set password_hash=${hash} where email = any(${h.db.array(
    USERS.map((u) => `${u}@sunpride.test`),
    "TEXT",
  )})`;
  probe = createDb(h.dbUrl, { max: 1 });
}, 240_000);
afterAll(async () => {
  await probe?.close();
  await h?.close();
}, 60_000);

/** @param {string} who */
async function signIn(who) {
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      app: "web",
      email: `${who}@sunpride.test`,
      password: PASSWORD,
    }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  await res.text();
  return { status: res.status, cookie };
}

/** @param {string} cookie @param {string} path @param {any} [body] */
async function call(cookie, path, body) {
  const res = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      connection: "close",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  // No SAP credit snapshot in this fixture: approval answers its documented, retryable
  // business refusal. That is an answer, not a stuck pool.
  if (res.status === 503 && text.includes('"credit_unavailable"')) return 409;
  if (res.status >= 500)
    console.log("SP0169_5XX", path, res.status, text.slice(0, 300));
  return res.status;
}

/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => /** @type {const} */ ("hung"))]);

test(`${ROUNDS} mixed bursts (sign-in, profile, analytics, order approvals, scheduler) on a pool of 3 all answer`, async () => {
  const sessions = Object.fromEntries(
    await Promise.all(
      USERS.map(async (u) => {
        const s = await signIn(u);
        expect(s.status).toBe(200);
        return [u, s.cookie];
      }),
    ),
  );
  const pending =
    await h.db`select id from orders where status='pending_approval' order by id`;
  /** @type {Record<string, number>} */ const failures = {};
  let ok = 0;
  /** @type {any[]} */ const idle = [];
  let watching = true;
  // Watch for a transaction left idle while the burst runs (the incident signature).
  const watcher = (async () => {
    while (watching) {
      const rows =
        await probe`select pid, state, now()-state_change as for, left(query,80) q from pg_stat_activity where datname=current_database() and state like 'idle in transaction%' and now()-state_change > interval '3 seconds'`;
      idle.push(...rows);
      await Bun.sleep(250);
    }
  })();
  const from = new Date(Date.parse(today) - 6 * 86400_000)
    .toISOString()
    .slice(0, 10);
  for (let r = 0; r < ROUNDS; r++) {
    /** @type {Array<() => Promise<number>>} */
    const work = [];
    for (const u of USERS) {
      work.push(() => signIn(u).then((s) => s.status));
      work.push(() => call(sessions[u], "/api/auth/me"));
      work.push(() =>
        call(
          sessions[u],
          `/api/v1/analytics/sales?from=${from}&to=${today}&groupBy=agent`,
        ),
      );
      work.push(() =>
        call(sessions[u], `/api/v1/analytics/today?date=${today}`),
      );
    }
    for (const o of pending)
      work.push(() =>
        call(sessions.manager, "/api/v1/orders/approve", {
          id: o.id,
          reason: "SP-0169 burst",
          idempotencyKey: `sp0169-${o.id}-${r}`,
        }),
      );
    const results = await Promise.all(
      [...work, ...work].map(async (w, i) => {
        try {
          const status = await within(w(), 30_000);
          if (status === "hung") return `timeout #${i % work.length}`;
          return status >= 500 ? `${status} #${i % work.length}` : null;
        } catch (e) {
          return `throw ${String(e).slice(0, 80)}`;
        }
      }),
    );
    for (const x of results)
      if (x) failures[x] = (failures[x] ?? 0) + 1;
      else ok++;
  }
  watching = false;
  await watcher;
  const [{ one }] = await within(h.db`select 1 as one`, 5_000).then((x) =>
    x === "hung" ? [{ one: "hung" }] : x,
  );
  if (one !== 1)
    console.log(
      "SP0169_STUCK",
      JSON.stringify(
        await probe`select pid, state, wait_event_type, wait_event, now()-state_change as for, left(query,100) q from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()`,
      ),
    );
  console.log(
    "SP0169_HTTP_BURST",
    JSON.stringify({ ok, failures, idle: idle.length }),
  );
  expect(failures).toEqual({});
  expect(idle).toEqual([]);
  expect(one).toBe(1);
}, 240_000);
