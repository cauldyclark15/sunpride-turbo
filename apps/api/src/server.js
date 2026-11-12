import { createDb } from "@sunpride/db/client";
import { createApp } from "./core/app.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
// SP-0169 safeguard: Postgres ends a transaction left idle (and frees its locks) or a
// runaway statement, so one stuck request/job cannot block profile writes or sign-in.
// Every pool this process opens (API pool, scheduler lock connection) inherits these.
// Override with env; 0 turns one off.
process.env.SP_DB_IDLE_TX_TIMEOUT_MS ??= "60000";
process.env.SP_DB_STATEMENT_TIMEOUT_MS ??= "300000";
const port = Number(process.env.PORT ?? 4310);
const db = createDb(url, { max: Number(process.env.DB_POOL_MAX ?? 20) });
const app = createApp({ db, dbUrl: url, env: process.env });
const server = await app.start({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
});
console.log(`[api] listening on ${server.hostname}:${server.port}`);
console.log(
  `[api] db safeguards: idle_in_transaction_session_timeout=${process.env.SP_DB_IDLE_TX_TIMEOUT_MS}ms statement_timeout=${process.env.SP_DB_STATEMENT_TIMEOUT_MS}ms`,
);

let stopping = false;
const SHUTDOWN_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
/** @param {Promise<any>} p @param {number} ms */
const bounded = (p, ms) =>
  Promise.race([
    p.then(
      () => true,
      () => false,
    ),
    Bun.sleep(ms).then(() => false),
  ]);
// SP-0169: a wedged pool (connections stuck on locks) made SIGTERM wait forever and
// needed kill -9. Bound every step; a second signal exits at once.
async function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  const timer = setTimeout(() => {
    console.error("[api] shutdown timed out; exiting");
    process.exit(1);
  }, SHUTDOWN_MS + 2_000);
  timer.unref?.();
  const stopped = await bounded(app.stop(), SHUTDOWN_MS / 2);
  const closed = await bounded(db.close({ timeout: 2 }), SHUTDOWN_MS / 2);
  process.exit(stopped && closed ? 0 : 1);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
