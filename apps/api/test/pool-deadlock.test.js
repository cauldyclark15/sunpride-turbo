import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, tx } from "@sunpride/db/client";
import { createScheduler, enqueue } from "../src/core/jobs.js";
import { publish } from "../src/core/realtime.js";
import { recordChange } from "../src/core/sync.js";
import { startHarness } from "./harness.js";

// SP-0169 (P0, round-5 test lane): the Bun API hung for all DB work. A transaction held
// locks and then awaited the SHARED pool; every other pool connection was queued on those
// locks, so the pool could never hand it a connection. pg_stat_activity showed the holder
// "idle in transaction" for minutes. These tests use a one-connection pool, where the
// same wait is immediate and deterministic.

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let probe;
beforeAll(async () => {
  h = await startHarness({ poolMax: 1 });
  probe = createDb(h.dbUrl, { max: 1 });
});
afterAll(async () => {
  await probe?.close();
  await h?.close();
});

/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => /** @type {const} */ ("hung"))]);

describe("pool-bound side effects inside a transaction (pool max 1)", () => {
  test("enqueue(pool) inside tx runs on the transaction and rolls back with it", async () => {
    const key = crypto.randomUUID();
    const result = await within(
      tx(h.db, async (t) => {
        await t`select 1`;
        await enqueue(h.db, { kind: "sp0169.probe", key, payload: {} });
        const [seen] =
          await t`select count(*)::int n from jobs where coalesce_key=${key}`;
        if (seen.n !== 1) throw new Error("job not visible in its transaction");
        throw new Error("rollback");
      }).catch((e) => String(e.message)),
      5_000,
    );
    expect(result).toBe("rollback");
    const [after] =
      await probe`select count(*)::int n from jobs where coalesce_key=${key}`;
    expect(after.n).toBe(0);
  }, 15_000);

  test("publish(pool) and recordChange(pool) inside tx complete on the transaction", async () => {
    const id = crypto.randomUUID();
    const result = await within(
      tx(h.db, async (t) => {
        await t`select 1`;
        await publish(h.db, "sp0169.probe");
        await recordChange(h.db, {
          entity: "sp0169.probe",
          entityId: id,
          scopeKey: "global",
        });
        return "done";
      }),
      5_000,
    );
    expect(result).toBe("done");
    const [row] =
      await probe`select count(*)::int n from change_log where entity_id=${id}`;
    expect(row.n).toBe(1);
  }, 15_000);

  test("a direct pool query inside tx is refused immediately, not left to hang", async () => {
    const result = await within(
      tx(h.db, async (t) => {
        await t`select 1`;
        await h.db`select 1`;
      }).catch((e) => String(e.message)),
      5_000,
    );
    expect(String(result)).toContain("SP-0169");
    expect((await within(h.db`select 2 as v`, 3_000))[0].v).toBe(2);
  }, 15_000);
});

describe("scheduler", () => {
  test("more concurrent tasks than pool connections all finish (the round-5 hang)", async () => {
    const db = createDb(h.dbUrl, { max: 2 });
    const scheduler = createScheduler({
      db,
      dbUrl: h.dbUrl,
      log: () => undefined,
    });
    /** @type {Set<string>} */ const finished = new Set();
    for (const n of ["a", "b", "c", "d"])
      scheduler.every(10, `sp0169.task.${n}`, async ({ db: taskDb }) => {
        if (finished.has(n)) return;
        await taskDb`select pg_sleep(0.2)`;
        await tx(taskDb, (t) => t`select 1`);
        finished.add(n);
      });
    scheduler.start();
    try {
      const t0 = Date.now();
      while (finished.size < 4 && Date.now() - t0 < 8_000) await Bun.sleep(25);
      expect([...finished].sort()).toEqual(["a", "b", "c", "d"]);
      expect((await within(db`select 3 as v`, 3_000))[0].v).toBe(3);
    } finally {
      await within(scheduler.stop(), 5_000);
      await db.close({ timeout: 1 });
    }
  }, 20_000);

  test("a running task holds no idle transaction and its pool queries proceed", async () => {
    const db = createDb(h.dbUrl, { max: 2 });
    const scheduler = createScheduler({ db, log: () => undefined });
    /** @type {any[]} */ const seen = [];
    let done = /** @type {(v?: any) => void} */ (() => {});
    const finished = new Promise((r) => (done = r));
    scheduler.every(10, "sp0169.probe", async ({ db: taskDb }) => {
      if (seen.length) return;
      // While the task runs, look for a scheduler transaction left idle (the evidence's
      // `idle in transaction ... pg_try_advisory_xact_lock` connection).
      const rows =
        await probe`select state, query from pg_stat_activity where datname=current_database() and state like 'idle in transaction%' and query like '%advisory%'`;
      seen.push(...rows);
      seen.push({ pool: (await taskDb`select 7 as v`)[0].v });
      done();
    });
    scheduler.start();
    try {
      expect(await within(finished, 8_000)).not.toBe("hung");
      expect(seen).toEqual([{ pool: 7 }]);
    } finally {
      await scheduler.stop();
      await db.close();
    }
  }, 20_000);
});

describe("shutdown", () => {
  test("SIGTERM exits within the shutdown bound while a request is stuck on a lock", async () => {
    const email = `sp0169-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await probe`insert into users(email,password_hash) values(${email},'x')`;
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const proc = Bun.spawn([process.execPath, "src/server.js"], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: h.dbUrl,
        PORT: String(port),
        HOST: "127.0.0.1",
        DB_POOL_MAX: "2",
        SHUTDOWN_TIMEOUT_MS: "3000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const lock = createDb(h.dbUrl, { max: 1 });
    /** @type {() => void} */ let release = () => {};
    const held = new Promise((r) => (release = () => r(undefined)));
    /** @type {Promise<any>|undefined} */ let holder;
    try {
      for (let i = 0; i < 100; i++) {
        const up = await fetch(`http://127.0.0.1:${port}/healthz`).then(
          () => true,
          () => false,
        );
        if (up) break;
        await Bun.sleep(100);
      }
      // Hold the user's row lock so sign-in parks inside its transaction.
      /** @type {() => void} */ let locked = () => {};
      const isLocked = new Promise((r) => (locked = () => r(undefined)));
      holder = tx(lock, async (t) => {
        await t`select id from users where email=${email} for update`;
        locked();
        await held;
      });
      await isLocked;
      const stuck = fetch(`http://127.0.0.1:${port}/api/auth/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app: "web", email, password: "whatever" }),
      }).catch(() => null);
      await Bun.sleep(500);
      const t0 = Date.now();
      proc.kill("SIGTERM");
      const exited = await within(proc.exited, 10_000);
      expect(exited).not.toBe("hung");
      expect(Date.now() - t0).toBeLessThan(8_000);
      void stuck;
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      release();
      await holder?.catch(() => undefined);
      await lock.close();
    }
  }, 30_000);
});
