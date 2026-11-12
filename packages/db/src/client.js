import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { SQL } from "bun";

/** @typedef {InstanceType<typeof SQL>} Db */

/** @param {any} v */
const isTemplate = (v) => Array.isArray(v) && Object.hasOwn(v, "raw");
const TX_OPTIONS = /^[a-z ]*$/i;

/** Settle a callback result the way Bun's begin() does (an array of queries is awaited).
 * @param {any} r */
const settle = (r) => (Array.isArray(r) ? Promise.all(r) : r);

/**
 * A transaction handle on one reserved connection: queries, `unsafe`, and `savepoint`.
 * Once its scope ends every further query is refused, so a stray (unawaited) query can
 * never run on the connection after it goes back to the pool.
 * @param {any} c @param {{ open: boolean }} scope @param {{ n: number }} seq
 */
function txHandle(c, scope, seq) {
  const guard = () => {
    if (!scope.open)
      throw new Error("Transaction is closed; await every query inside it");
  };
  /** @type {any} */
  const handle = new Proxy(c, {
    apply(target, thisArg, args) {
      if (isTemplate(args[0])) guard();
      return Reflect.apply(target, thisArg, args);
    },
    get(target, key) {
      if (key === "unsafe")
        return (/** @type {string} */ q, /** @type {any[]} */ p) => {
          guard();
          return target.unsafe(q, p);
        };
      // Nested begin() on a transaction handle is a savepoint, as with Bun's own handles.
      if (key === "savepoint" || key === "begin" || key === "transaction")
        return async (/** @type {any} */ a, /** @type {any} */ b) => {
          guard();
          const fn = typeof a === "function" ? a : b,
            name = `sp_${++seq.n}`,
            inner = { open: true };
          await target.unsafe(`savepoint ${name}`);
          try {
            const result = await settle(fn(txHandle(target, inner, seq)));
            inner.open = false;
            await target.unsafe(`release savepoint ${name}`);
            return result;
          } catch (error) {
            inner.open = false;
            await target.unsafe(`rollback to savepoint ${name}`);
            throw error;
          }
        };
      if (key === "release")
        return () => {
          throw new Error("release() is not allowed inside a transaction");
        };
      if (key in handleProps) return handleProps[key];
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, key, value) {
      handleProps[key] = value;
      return true;
    },
  });
  /** @type {Record<string|symbol, any>} */
  const handleProps = {};
  return handle;
}

/**
 * BEGIN … COMMIT/ROLLBACK on a reserved connection, without Bun's reserved `begin()`
 * (Bun 1.3.14 also re-raises a callback error as an unhandled rejection there, which
 * kills the process).
 * @param {any} c @param {string} options @param {(t:any)=>any} fn
 */
async function runTx(c, options, fn) {
  if (typeof options !== "string" || !TX_OPTIONS.test(options))
    throw new Error("Invalid transaction options");
  const scope = { open: true };
  await c.unsafe(options ? `begin ${options}` : "begin");
  try {
    const result = await settle(fn(txHandle(c, scope, { n: 0 })));
    scope.open = false;
    await c.unsafe("commit");
    return result;
  } catch (error) {
    scope.open = false;
    await c.unsafe("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * SP-0169 guard mode: "throw" under tests (NODE_ENV=test, which `bun test` sets), "warn"
 * otherwise; SP_DB_TX_GUARD=throw|warn|off overrides.
 * @param {string} [explicit]
 */
function txGuardMode(explicit) {
  const mode = explicit ?? process.env.SP_DB_TX_GUARD;
  if (mode === "throw" || mode === "warn" || mode === "off") return mode;
  return process.env.NODE_ENV === "test" ? "throw" : "warn";
}

/**
 * Create a pooled Postgres client (`Bun.sql`).
 *
 * Bun 1.3.14 pipelines plain pooled queries onto pool connections that `begin()` /
 * `reserve()` are taking for a transaction. Under bursts (~60 concurrent requests) a
 * request's query lands inside another request's open transaction ("SET TRANSACTION
 * ISOLATION LEVEL must be called before any query", "bind message supplies 0
 * parameters", ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE) and the pool then hangs. This
 * reproduces with plain Bun and no app code, while routing every pooled operation
 * through `reserve()` (one exclusive connection per query or transaction) is clean.
 * So this pool handle never runs a query directly: each query, `unsafe` call and
 * `begin` borrows its own reserved connection and releases it once settled.
 * Fragment helpers (`db(list)`, `db.array`) stay synchronous and connection-agnostic.
 * @param {string} url
 * @param {{ max?: number, txGuard?: "throw"|"warn"|"off" }} [options]
 * @returns {Db}
 */
export function createDb(url, options = {}) {
  if (!url) throw new Error("createDb: database URL is required");
  const raw = new SQL({ url, max: options.max ?? 10 });
  const guardMode = txGuardMode(options.txGuard);
  /** Open pool transactions of THIS pool on the current async path (SP-0169). */
  const inTx = new AsyncLocalStorage();
  /** @type {Set<string>} */ const warned = new Set();
  /** Refuse (or report) a pooled query/begin issued while this async path holds one of
   * this pool's transactions: it needs a second connection while the first sits idle in
   * transaction, possibly holding locks the other pool clients wait on. With every pool
   * connection taken that is an in-process deadlock (SP-0169: the API hung for all DB
   * work). Use the transaction handle, or run the query before/after the transaction. */
  const checkNotInTx = (/** @type {string} */ origin = "") => {
    if (guardMode === "off") return;
    const store = inTx.getStore();
    if (!store || !store.open) return;
    const error = new Error(
      "Pool query inside an open transaction: use the transaction handle (SP-0169 pool deadlock)",
    );
    if (origin) error.stack = `${error.message}\n${origin}`;
    if (process.env.SP_DB_TX_GUARD_LOG)
      appendFileSync(
        process.env.SP_DB_TX_GUARD_LOG,
        `${error.stack}\n----\n`,
      );
    if (guardMode === "throw") throw error;
    const site = String(error.stack).split("\n").slice(1, 8).join("\n");
    if (warned.has(site)) return;
    warned.add(site);
    console.warn(`[db] ${error.message}\n${site}`);
  };
  /** @template T @param {(c:any)=>Promise<T>} fn @returns {Promise<T>} */
  const exclusive = async (fn) => {
    const c = await raw.reserve();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  };
  /**
   * Keep Bun's lazy Query object, so it still nests as a fragment inside another query
   * (`${db`and …`}`, `${db.unsafe(expr)}`), but run it standalone only on a reserved
   * connection. Bun's Query runs itself from then/catch/finally/execute; route them all.
   * @param {any} query @param {(c:any)=>any} make
   */
  const lazy = (query, make) => {
    /** @type {Promise<any>|undefined} */ let run;
    // The creating call site is the useful one for a guard report (the run is async).
    const origin =
      guardMode !== "off" && inTx.getStore()?.open
        ? String(new Error().stack).split("\n").slice(2).join("\n")
        : undefined;
    /** @type {string[]} */ const modes = [];
    const start = () => {
      if (!run) checkNotInTx(origin);
      return (run ??= exclusive((c) =>
        modes.reduce((/** @type {any} */ q, m) => q[m](), make(c)),
      ));
    };
    Object.defineProperties(query, {
      then: {
        value: (/** @type {any} */ ok, /** @type {any} */ fail) =>
          start().then(ok, fail),
      },
      catch: { value: (/** @type {any} */ fail) => start().catch(fail) },
      finally: { value: (/** @type {any} */ f) => start().finally(f) },
      execute: { value: () => (start(), query) },
      run: { value: () => (start(), query) },
      ...Object.fromEntries(
        ["values", "raw", "simple"].map((m) => [
          m,
          { value: () => (modes.push(m), query) },
        ]),
      ),
    });
    return query;
  };
  return /** @type {Db} */ (
    new Proxy(raw, {
      apply(target, thisArg, args) {
        const query = Reflect.apply(target, thisArg, args);
        if (!isTemplate(args[0])) return query;
        return lazy(query, (/** @type {any} */ c) => c(...args));
      },
      get(target, key) {
        if (key === "unsafe")
          return (/** @type {string} */ q, /** @type {any[]} */ p) =>
            lazy(target.unsafe(q, p), (/** @type {any} */ c) =>
              c.unsafe(q, p),
            );
        if (key === "begin" || key === "transaction")
          return async (/** @type {any} */ a, /** @type {any} */ b) => {
            checkNotInTx();
            /** @type {{ open: boolean, handle?: any }} */
            const store = { open: true };
            const fn = typeof a === "function" ? a : b;
            const bind = (/** @type {any} */ t) => {
              store.handle = t;
              return fn(t);
            };
            try {
              return await exclusive((c) =>
                inTx.run(store, () =>
                  runTx(c, typeof a === "function" ? "" : a, bind),
                ),
              );
            } finally {
              store.open = false;
            }
          };
        // The open transaction of this pool on the current async path, if any.
        if (key === "activeTx") {
          const store = inTx.getStore();
          return store?.open ? store.handle : undefined;
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
  );
}

/**
 * Run `fn` inside one transaction. Nested calls on a transaction handle use a savepoint.
 * @template T
 * @param {Db} db
 * @param {(tx: Db) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function tx(db, fn) {
  const anyDb = /** @type {any} */ (db);
  if (typeof anyDb.savepoint === "function" && anyDb.__inTx) {
    return /** @type {Promise<T>} */ (anyDb.savepoint(fn));
  }
  return /** @type {Promise<T>} */ (
    anyDb.begin(async (/** @type {any} */ t) => {
      t.__inTx = true;
      return fn(t);
    })
  );
}

/**
 * SP-0169: the handle a pool-bound side effect (publish, enqueue, recordChange) must use:
 * the transaction this async path holds on `db`, else `db` itself. Using the bare pool
 * there needs a second connection while the transaction's connection waits (deadlock
 * under load); on the transaction a NOTIFY/job lands at COMMIT and never on rollback.
 * @param {any} db
 */
export function ambient(db) {
  return (db && !db.__inTx && db.activeTx) || db;
}
