import { test, expect } from "bun:test";
import * as client from "../src/client.js";

// SP-0169 (analytics hang, 22:38 codex lane + round-5 second stuck connection):
// rebuildDay ran readVisits/readSales/people under Promise.all on ONE transaction
// handle. Bun 1.3.14 strands a transaction connection when two different prepared
// statements are each in flight twice (A,B,A,B): the client waits forever and Postgres
// shows the backend `idle in transaction / ClientRead`, still holding its advisory and
// profile key-share locks. These tests pin (1) transaction handles never pipeline and
// (2) the session safeguards that make Postgres end a transaction stuck idle.
const { createDb, tx } = client;
const lane = process.env.SP_LANE ?? "core";
if (!/^[a-z0-9_]+$/.test(lane)) throw new Error("Invalid SP_LANE");
const url = (
  await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-${lane}-url`).text()
).trim();

/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => /** @type {const} */ ("hung"))]);

test("concurrent statements on one transaction handle complete (A,B,A,B no longer strands the connection)", async () => {
  // One pool connection, so the transaction reuses it with statement A already
  // prepared — as on a long-running API. A warm A plus a new B, each in flight twice,
  // strands Bun 1.3.14 deterministically when the handle pipelines.
  const db = createDb(url, { max: 1 });
  const monitor = createDb(url, { max: 1 });
  try {
    await tx(db, async (t) => t`select ${9}::int as k`);
    const result = await within(
      tx(db, async (t) => {
        await t`select 0`;
        return Promise.all([
          t`select ${1}::int as k`,
          t`select ${"a"}::text as s`,
          t`select ${2}::int as k`,
          t`select ${"b"}::text as s`,
          t.unsafe("select $1::int as n", [3]),
        ]);
      }),
      4000,
    );
    const stuck =
      await monitor`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'`;
    expect(stuck[0].n).toBe(0);
    expect(result).not.toBe("hung");
    const rows = /** @type {any[]} */ (result);
    expect(rows.map((r) => r[0].k ?? r[0].s ?? r[0].n)).toEqual([
      1,
      "a",
      2,
      "b",
      3,
    ]);
  } finally {
    await monitor.close({ timeout: 1 });
    await db.close({ timeout: 1 });
  }
});

test("ordered transaction handles keep fragments, savepoints and errors working", async () => {
  const db = createDb(url, { max: 2 });
  try {
    const out = await tx(db, async (t) => {
      const cond = t`and x > ${1}`; // a fragment, never run on its own
      const [a, b] = await Promise.all([
        t`select count(*)::int n from (values (1),(2),(3)) v(x) where true ${cond}`,
        tx(t, async (s) => (await s`select ${7}::int as v`)[0].v),
      ]);
      const failed = await /** @type {any} */ (t)
        .savepoint(async (/** @type {any} */ s) => {
          await s`select 1/0`;
        })
        .then(
          () => "no error",
          (/** @type {any} */ e) => String(e.message),
        );
      const [after] = await t`select ${9}::int as v`;
      return { n: a[0].n, b, failed, after: after.v };
    });
    expect(out).toEqual({ n: 2, b: 7, failed: expect.stringContaining("division"), after: 9 });
  } finally {
    await db.close({ timeout: 1 });
  }
});

test("idle_in_transaction_session_timeout ends a stuck transaction and frees its locks", async () => {
  // Runs in a child: when Postgres ends the session, Bun 1.3.14 also reports the socket
  // close once as an unhandled ERR_POSTGRES_EXPECTED_REQUEST (no pending query), which
  // bun test counts as a failure; a server process logs it and keeps serving.
  const child = Bun.spawn(
    ["bun", new URL("./fixtures/idle-tx-timeout.mjs", import.meta.url).pathname],
    { env: { ...process.env, SP_LANE: lane }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await within(new Response(child.stdout).text(), 10_000);
  if (out === "hung") child.kill(9);
  expect(out).not.toBe("hung");
  const result = JSON.parse(String(out).trim().split("\n").at(-1) ?? "{}");
  expect(result).toEqual({
    idle: "500ms",
    waiter: "got lock",
    stuck: "ended",
    after: 1,
    alive: true,
  });
});

test("a session advisory lock held outside a transaction survives the idle timeout (scheduler lock connection)", async () => {
  const LOCK = 7_318_000 + Math.floor(Math.random() * 1000);
  const lockDb = createDb(url, { max: 1, idleInTransactionTimeoutMs: 300 });
  const other = createDb(url, { max: 1 });
  try {
    await lockDb.begin(async () => {}); // a no-op transaction must not leave it idle in tx
    const c = await /** @type {any} */ (lockDb).reserve();
    try {
      const [a] = await c`select pg_try_advisory_lock(${LOCK}) as ok`;
      expect(a.ok).toBe(true);
      await Bun.sleep(900); // 3x the idle-in-transaction timeout
      const [b] = await other`select pg_try_advisory_lock(${LOCK}) as ok`;
      expect(b.ok).toBe(false); // still held: the connection is idle, not idle in tx
      const [st] =
        await other`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'`;
      expect(st.n).toBe(0);
      await c`select pg_advisory_unlock(${LOCK})`;
    } finally {
      c.release();
    }
  } finally {
    await other.close({ timeout: 1 });
    await lockDb.close({ timeout: 1 });
  }
});

test("session safeguards come from env and stay off when unset", () => {
  const save = {
    i: process.env.SP_DB_IDLE_TX_TIMEOUT_MS,
    s: process.env.SP_DB_STATEMENT_TIMEOUT_MS,
  };
  try {
    delete process.env.SP_DB_IDLE_TX_TIMEOUT_MS;
    delete process.env.SP_DB_STATEMENT_TIMEOUT_MS;
    expect(client.sessionSettings()).toEqual({});
    process.env.SP_DB_IDLE_TX_TIMEOUT_MS = "60000";
    process.env.SP_DB_STATEMENT_TIMEOUT_MS = "300000";
    expect(client.sessionSettings()).toEqual({
      idle_in_transaction_session_timeout: "60000",
      statement_timeout: "300000",
    });
    expect(client.sessionSettings({ statementTimeoutMs: 0 })).toEqual({
      idle_in_transaction_session_timeout: "60000",
    });
  } finally {
    for (const [k, v] of [
      ["SP_DB_IDLE_TX_TIMEOUT_MS", save.i],
      ["SP_DB_STATEMENT_TIMEOUT_MS", save.s],
    ])
      if (v === undefined) delete process.env[/** @type {string} */ (k)];
      else process.env[/** @type {string} */ (k)] = v;
  }
});
