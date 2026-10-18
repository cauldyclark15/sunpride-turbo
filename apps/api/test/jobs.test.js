import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  createScheduler,
  enqueue,
  nextDailyRun,
  registerJob,
  runDueJobs,
} from "../src/core/jobs.js";
import { startHarness } from "./harness.js";

/** @type {import('./harness.js').Harness} */
let h;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("jobs table worker", () => {
  test("coalescing enqueue runs once", async () => {
    /** @type {any[]} */
    const seen = [];
    registerJob("rollup.refresh", ({ payload }) => void seen.push(payload));
    const a = await enqueue(h.db, {
      kind: "rollup.refresh",
      key: "person:1|2026-10-19",
      payload: { n: 1 },
    });
    const b = await enqueue(h.db, {
      kind: "rollup.refresh",
      key: "person:1|2026-10-19",
      payload: { n: 2 },
    });
    const other = await enqueue(h.db, {
      kind: "rollup.refresh",
      key: "person:2|2026-10-19",
      payload: { n: 3 },
    });
    expect(b).toBe(a);
    expect(other).not.toBe(a);
    // Rolled-back enqueue never lands.
    await tx(h.db, async (t) => {
      await enqueue(t, {
        kind: "rollup.refresh",
        key: "person:3|2026-10-19",
        payload: { n: 4 },
      });
      throw new Error("rollback");
    }).catch(() => {});
    const scheduler = createScheduler({ db: h.db });
    const processed = await scheduler.drain();
    expect(processed).toBe(2);
    expect(seen).toEqual(expect.arrayContaining([{ n: 1 }, { n: 3 }]));
    expect(seen.length).toBe(2);
    expect(await runDueJobs(h.db)).toBe(0);
    // After it ran, the same key may be enqueued again.
    const c = await scheduler.enqueue(
      "rollup.refresh",
      "person:1|2026-10-19",
      null,
      { n: 5 },
    );
    expect(c).not.toBe(a);
    await scheduler.drain();
    expect(seen.length).toBe(3);
  });

  test("future run_at waits; failures retry with backoff then give up", async () => {
    let calls = 0;
    registerJob("flaky", () => {
      calls++;
      throw new Error("boom");
    });
    const later = await enqueue(h.db, {
      kind: "flaky",
      key: "later",
      runAt: Date.now() + 60_000,
    });
    expect(await runDueJobs(h.db)).toBe(0);
    await h.db`update jobs set run_at = now() where id = ${later}`;
    expect(await runDueJobs(h.db)).toBe(1);
    let [row] =
      await h.db`select status, attempts, last_error, run_at > now() as deferred from jobs where id = ${later}`;
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "boom",
      deferred: true,
    });
    for (let i = 0; i < 4; i++) {
      await h.db`update jobs set run_at = now() where id = ${later}`;
      await runDueJobs(h.db);
    }
    [row] = await h.db`select status, attempts from jobs where id = ${later}`;
    expect(row).toEqual({ status: "failed", attempts: 5 });
    expect(calls).toBe(5);
  });
});

describe("scheduler", () => {
  test("every() ticks; a named task never runs twice at once across schedulers", async () => {
    const s1 = createScheduler({ db: h.db, pollMs: 1000 });
    let ticks = 0;
    s1.every(20, "tick", () => void ticks++);
    s1.start();
    await Bun.sleep(150);
    await s1.stop();
    expect(ticks).toBeGreaterThanOrEqual(2);

    const s2 = createScheduler({ db: h.db });
    const s3 = createScheduler({ db: h.db });
    let running = 0;
    let maxRunning = 0;
    const slow = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(150);
      running--;
    };
    s2.daily("22:00", "Asia/Manila", "day.close", slow);
    s3.daily("22:00", "Asia/Manila", "day.close", slow);
    const results = await Promise.all([
      s2.runNow("day.close"),
      s3.runNow("day.close"),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(maxRunning).toBe(1);
  });

  test("daily times are Manila wall-clock", () => {
    const at = (/** @type {string} */ iso) => new Date(iso).getTime();
    expect(
      nextDailyRun("22:00", "Asia/Manila", at("2026-10-19T13:00:00Z")),
    ).toBe(at("2026-10-19T14:00:00Z"));
    expect(
      nextDailyRun("22:00", "Asia/Manila", at("2026-10-19T14:00:00Z")),
    ).toBe(at("2026-10-20T14:00:00Z"));
    expect(
      nextDailyRun("00:15", "Asia/Manila", at("2026-10-19T13:00:00Z")),
    ).toBe(at("2026-10-19T16:15:00Z"));
    expect(
      nextDailyRun("19:40", "Asia/Manila", at("2026-10-19T17:00:00Z")),
    ).toBe(at("2026-10-20T11:40:00Z"));
    expect(() => nextDailyRun("24:00", "Asia/Manila", 0)).toThrow();
  });
});
