// Child process for client-tx-order.test.js (SP-0169): a transaction left idle with a
// lock is ended by idle_in_transaction_session_timeout, the lock is freed, the pool
// recovers and the process survives. Prints one JSON line.
import { createDb, tx } from "../../src/client.js";

const lane = process.env.SP_LANE ?? "core";
if (!/^[a-z0-9_]+$/.test(lane)) throw new Error("Invalid SP_LANE");
const url = (
  await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-${lane}-url`).text()
).trim();
/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => /** @type {const} */ ("hung"))]);
const LOCK = 7_317_000 + Math.floor(Math.random() * 1000);
const db = createDb(url, { max: 2, idleInTransactionTimeoutMs: 500 });
const other = createDb(url, { max: 1 });
const [s] =
  await db`select current_setting('idle_in_transaction_session_timeout') as idle`;
/** @type {() => void} */ let locked = () => {};
const holds = new Promise((r) => (locked = () => r(undefined)));
const stuck = tx(db, async (t) => {
  await t`select pg_advisory_xact_lock(${LOCK})`;
  locked();
  await Bun.sleep(1500); // non-DB wait with the transaction open
  await t`select 1`;
}).then(
  () => "committed",
  () => "ended",
);
await holds;
const waiter = await within(
  other`select pg_advisory_xact_lock(${LOCK}) as ok`.then(() => "got lock"),
  4000,
);
const ended = await within(stuck, 4000);
const [after] = await db`select 1 as x`;
await Bun.sleep(100);
console.log(
  JSON.stringify({ idle: s.idle, waiter, stuck: ended, after: after.x, alive: true }),
);
process.exit(0);
