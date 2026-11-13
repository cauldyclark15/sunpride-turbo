import { test, expect } from "bun:test";
import * as client from "../src/client.js";

// SP-0169: the API hung for all DB work. A transaction awaited a query on the shared pool
// while every other pool connection waited on a lock that transaction held — an
// in-process deadlock that only `kill -9` ended. These tests pin the guard that turns
// that hang into an immediate error, and the ambient helper that keeps side effects on
// the transaction.
const { createDb, tx } = client;
const lane = process.env.SP_LANE ?? "core";
if (!/^[a-z0-9_]+$/.test(lane)) throw new Error("Invalid SP_LANE");
const url = (
  await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-${lane}-url`).text()
).trim();

/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => /** @type {const} */ ("hung"))]);
const LOCK = 7_316_900 + Math.floor(Math.random() * 1000);

test("a pool query inside a transaction fails fast instead of deadlocking an exhausted pool", async () => {
  const db = createDb(url, { max: 2, txGuard: "throw" });
  try {
    /** @type {() => void} */ let locked = () => {};
    const holds = new Promise((r) => (locked = () => r(undefined)));
    // Request A: holds the lock, then (wrongly) asks the shared pool for more data.
    const a = tx(db, async (t) => {
      await t`select pg_advisory_xact_lock(${LOCK})`;
      locked();
      await Bun.sleep(200); // let B take the last pool connection and queue on the lock
      return (await db`select 1 as x`)[0].x;
    }).then(
      (x) => ({ ok: x }),
      (e) => ({ error: String(e.message) }),
    );
    await holds;
    // Request B: the last pool connection, waiting on A's lock (sign-in / order command).
    const b = tx(db, async (t) => {
      await t`select pg_advisory_xact_lock(${LOCK})`;
      return "b done";
    });
    const result = await within(Promise.all([a, b]), 8_000);
    expect(result).not.toBe("hung");
    const [ra, rb] = /** @type {any} */ (result);
    expect(ra.error).toContain("SP-0169");
    expect(rb).toBe("b done");
    // The pool is healthy afterwards.
    expect(await within(db`select 2 as y`.then((r) => r[0].y), 3_000)).toBe(2);
  } finally {
    await within(db.close({ timeout: 1 }), 3_000);
  }
}, 20_000);

test("ambient(db) runs a side effect on the open transaction, so it completes under the same exhaustion", async () => {
  const { ambient } = /** @type {any} */ (client);
  expect(typeof ambient).toBe("function");
  const db = createDb(url, { max: 2, txGuard: "throw" });
  try {
    /** @type {() => void} */ let locked = () => {};
    const holds = new Promise((r) => (locked = () => r(undefined)));
    const a = tx(db, async (t) => {
      await t`select pg_advisory_xact_lock(${LOCK + 1})`;
      locked();
      await Bun.sleep(200);
      // publish/enqueue/recordChange pass the pool; ambient() resolves the transaction.
      const [row] =
        await ambient(db)`select txid_current() as id`;
      const [mine] = await t`select txid_current() as id`;
      return row.id === mine.id;
    });
    await holds;
    const b = tx(db, async (t) => {
      await t`select pg_advisory_xact_lock(${LOCK + 1})`;
      return "b done";
    });
    const result = await within(Promise.all([a, b]), 8_000);
    expect(result).toEqual([true, "b done"]);
    // Outside a transaction it is the pool itself.
    expect(ambient(db)).toBe(db);
  } finally {
    await within(db.close({ timeout: 1 }), 3_000);
  }
}, 20_000);

test("the guard has no false positives: after commit, other pools, fragments, and off mode", async () => {
  const db = createDb(url, { max: 2, txGuard: "throw" });
  const other = createDb(url, { max: 1, txGuard: "throw" });
  const off = createDb(url, { max: 2, txGuard: "off" });
  try {
    /** @type {Promise<any>|undefined} */ let later;
    await tx(db, async (t) => {
      // A pool fragment nested into a transaction query is not a pool round trip.
      expect(
        await t`select 1 as a where true ${db`and ${2}::int = 2`}`.values(),
      ).toEqual([[1]]);
      // Another client (another process's work) is not this pool.
      expect((await other`select 3 as v`)[0].v).toBe(3);
      // A continuation that runs after commit may use the pool.
      later = Bun.sleep(50).then(() => db`select 4 as v`);
    });
    expect((await later)[0].v).toBe(4);
    // Nested db.begin on the pool inside a transaction is the same deadlock.
    await expect(
      tx(db, async () => {
        await db.begin(async (/** @type {any} */ t) => t`select 1`);
      }),
    ).rejects.toThrow("SP-0169");
    // Opt-out mode keeps the old behaviour (used only by explicit callers).
    expect(
      await tx(off, async () => (await off`select 5 as v`)[0].v),
    ).toBe(5);
  } finally {
    await Promise.all([db.close(), other.close(), off.close()]);
  }
}, 20_000);
