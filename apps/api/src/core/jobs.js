/**
 * In-process scheduler (replaces Convex crons) plus the durable `jobs` table worker.
 *
 * - `every(ms, name, fn)` / `daily('HH:MM', 'Asia/Manila', name, fn)`: recurring work. Each run
 *   holds a Postgres advisory lock named after the job, so several API processes never run the
 *   same tick twice concurrently, and a slow run is never overlapped in-process.
 * - `enqueue(kind, key, runAt, payload)`: durable deferred work with coalescing — at most one
 *   PENDING row per (kind, key); a second enqueue returns the pending row's id.
 */

/** @typedef {(ctx: { db: any, payload: any, job: any }) => Promise<void>|void} JobHandler */

/** @type {Map<string, JobHandler>} */
const handlers = new Map();
export const MAX_ATTEMPTS = 5;

/** @param {string} kind @param {JobHandler} handler */
export function registerJob(kind, handler) {
  handlers.set(kind, handler);
}

export function clearJobHandlers() {
  handlers.clear();
}

/** @param {unknown} e */
const isUniqueViolation = (e) => {
  const err = /** @type {any} */ (e);
  return (
    err &&
    (err.errno === "23505" ||
      err.code === "23505" ||
      /duplicate key/.test(String(err.message)))
  );
};

/**
 * Durable, coalescing enqueue. Pass a transaction handle to enqueue atomically with a write.
 * @param {any} db
 * @param {import('./context.js').JobSpec} job
 * @returns {Promise<string|null>} job id (the existing pending id when coalesced)
 */
export async function enqueue(db, job) {
  const key = job.key ?? null;
  const runAt = job.runAt == null ? null : new Date(job.runAt);
  // Pass objects straight through: Bun.sql double-encodes a JSON *string* cast to jsonb.
  const payload =
    job.payload === undefined || job.payload === null ? {} : job.payload;
  if (typeof payload !== "object" || Array.isArray(payload))
    throw new Error("job payload must be a plain object");
  const rows = await db`
    insert into jobs (kind, coalesce_key, run_at, payload)
    values (${job.kind}, ${key}, coalesce(${runAt}::timestamptz, clock_timestamp()), ${payload})
    on conflict (kind, coalesce_key) where status = 'pending' and coalesce_key is not null do nothing
    returning id`;
  if (rows.length) return rows[0].id;
  const existing =
    await db`select id from jobs where kind = ${job.kind} and coalesce_key = ${key} and status = 'pending'`;
  return existing[0]?.id ?? null;
}

/** @param {number} attempts */
const retryDelaySecs = (attempts) => Math.min(30 * 2 ** (attempts - 1), 3600);

/**
 * Claim and run due jobs once. Returns the number processed.
 * @param {any} db @param {{ limit?: number }} [opts]
 */
export async function runDueJobs(db, opts = {}) {
  await db`update jobs set status = 'pending', locked_at = null
           where status = 'running' and locked_at < now() - interval '10 minutes'`;
  const claimed = await db`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
    where id in (
      select id from jobs where status = 'pending' and run_at <= now()
      order by run_at limit ${opts.limit ?? 10} for update skip locked)
    returning *`;
  for (const job of claimed) {
    const handler = handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      const payload =
        typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
      await handler({ db, payload, job });
      await db`update jobs set status = 'done', locked_at = null, last_error = null where id = ${job.id}`;
    } catch (error) {
      const message = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 2000);
      const final = Number(job.attempts) >= MAX_ATTEMPTS;
      try {
        if (final)
          await db`update jobs set status = 'failed', locked_at = null, last_error = ${message} where id = ${job.id}`;
        else
          await db`update jobs set status = 'pending', locked_at = null, last_error = ${message},
                     run_at = now() + make_interval(secs => ${retryDelaySecs(Number(job.attempts))}) where id = ${job.id}`;
      } catch (e) {
        // A newer pending row with the same key exists: it supersedes this retry.
        if (!isUniqueViolation(e)) throw e;
        await db`update jobs set status = 'failed', locked_at = null, last_error = ${`${message} (superseded)`} where id = ${job.id}`;
      }
    }
  }
  return claimed.length;
}

/**
 * Next instant (epoch ms, strictly after `now`) at local `HH:MM` in `timeZone`.
 * @param {string} hhmm @param {string} timeZone @param {number} now
 */
export function nextDailyRun(hhmm, timeZone, now) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`invalid time ${hhmm}`);
  const [hh, mm] = [Number(m[1]), Number(m[2])];
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  /** @param {number} t */
  const offsetAt = (t) => {
    /** @type {Record<string, number>} */
    const p = {};
    for (const part of fmt.formatToParts(new Date(t)))
      if (part.type !== "literal") p[part.type] = Number(part.value);
    return (
      Date.UTC(
        p.year ?? 0,
        (p.month ?? 1) - 1,
        p.day ?? 1,
        p.hour ?? 0,
        p.minute ?? 0,
        p.second ?? 0,
      ) -
      Math.floor(t / 1000) * 1000
    );
  };
  const off = offsetAt(now);
  const local = new Date(now + off);
  for (let d = 0; d < 3; d++) {
    const wallUtc = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + d,
      hh,
      mm,
    );
    const at = wallUtc - offsetAt(wallUtc - off);
    if (at > now) return at;
  }
  throw new Error("unreachable");
}

/**
 * @param {{ db: any, pollMs?: number, log?: (msg: string) => void }} opts
 */
export function createScheduler(opts) {
  const db = opts.db;
  const log = opts.log ?? ((m) => console.log(m));
  /** @type {Array<{ name: string, fn: (ctx: { db: any }) => any, next: () => number }>} */
  const tasks = [];
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  /** @type {Set<string>} */
  const running = new Set();
  let started = false;
  let workerBusy = false;

  /** @param {string} name @param {(ctx: { db: any }) => any} fn */
  async function runTask(name, fn) {
    if (running.has(name)) return false;
    running.add(name);
    try {
      return await db.begin(async (/** @type {any} */ t) => {
        const [row] =
          await t`select pg_try_advisory_xact_lock(hashtext(${`sched:${name}`})) as ok`;
        if (!row.ok) return false;
        await fn({ db });
        return true;
      });
    } catch (error) {
      log(
        `[scheduler] ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      running.delete(name);
    }
  }

  /** @param {typeof tasks[number]} task */
  function arm(task) {
    if (!started) return;
    const delay = Math.max(0, task.next() - Date.now());
    const timer = setTimeout(
      async () => {
        timers.delete(timer);
        await runTask(task.name, task.fn);
        arm(task);
      },
      Math.min(delay, 2 ** 31 - 1),
    );
    timers.add(timer);
  }

  function armWorker() {
    if (!started) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      await drain();
      armWorker();
    }, opts.pollMs ?? 1000);
    timers.add(timer);
  }

  async function drain() {
    if (workerBusy) return 0;
    workerBusy = true;
    let total = 0;
    try {
      for (let n = await runDueJobs(db); n > 0; n = await runDueJobs(db))
        total += n;
    } catch (error) {
      log(
        `[jobs] worker failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      workerBusy = false;
    }
    return total;
  }

  return {
    /** @param {number} ms @param {string} name @param {(ctx: { db: any }) => any} fn */
    every(ms, name, fn) {
      const task = { name, fn, next: () => Date.now() + ms };
      tasks.push(task);
      arm(task);
    },
    /** @param {string} hhmm @param {string} timeZone @param {string} name @param {(ctx: { db: any }) => any} fn */
    daily(hhmm, timeZone, name, fn) {
      nextDailyRun(hhmm, timeZone, Date.now()); // validate eagerly
      const task = {
        name,
        fn,
        next: () => nextDailyRun(hhmm, timeZone, Date.now()),
      };
      tasks.push(task);
      arm(task);
    },
    /** @param {string} kind @param {string|null} key @param {Date|number|null} runAt @param {unknown} payload */
    enqueue(kind, key, runAt, payload) {
      return enqueue(db, { kind, key, runAt, payload });
    },
    /** Run one named task now (tests/ops). @param {string} name */
    async runNow(name) {
      const task = tasks.find((t) => t.name === name);
      if (!task) throw new Error(`unknown task ${name}`);
      return runTask(task.name, task.fn);
    },
    drain,
    start() {
      if (started) return;
      started = true;
      for (const task of tasks) arm(task);
      armWorker();
    },
    async stop() {
      started = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      while (workerBusy || running.size) await Bun.sleep(10);
    },
    tasks,
  };
}
