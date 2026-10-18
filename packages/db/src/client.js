import { SQL } from "bun";

/** @typedef {InstanceType<typeof SQL>} Db */

/**
 * Create a pooled Postgres client (`Bun.sql`).
 * @param {string} url
 * @param {{ max?: number }} [options]
 * @returns {Db}
 */
export function createDb(url, options = {}) {
  if (!url) throw new Error("createDb: database URL is required");
  return new SQL({ url, max: options.max ?? 10 });
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
