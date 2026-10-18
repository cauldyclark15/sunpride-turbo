import { createDb } from "@sunpride/db/client";
import { createApp } from "./core/app.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 4310);
const db = createDb(url, { max: Number(process.env.DB_POOL_MAX ?? 20) });
const app = createApp({ db, dbUrl: url, env: process.env });
const server = await app.start({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
});
console.log(`[api] listening on ${server.hostname}:${server.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.stop();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
