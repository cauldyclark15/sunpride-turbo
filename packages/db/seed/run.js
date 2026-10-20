#!/usr/bin/env bun
import { createDb } from "../src/client.js";
import { seedDemo, resetDemo } from "./index.js";
import { seedModernTrade } from "./modern-trade.js";

const args = process.argv.slice(2);
let reset = false;
/** @type {{anchorDate?:string,days?:number}} */
const options = {};
let invalid = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--reset") reset = true;
  else if (args[i] === "--anchor-date" && args[i + 1])
    options.anchorDate = args[++i];
  else if (args[i] === "--days" && args[i + 1])
    options.days = Number(args[++i]);
  else invalid = true;
}
if (
  !process.env.DATABASE_URL ||
  invalid ||
  (reset && Object.keys(options).length > 0)
) {
  console.error(
    "Usage: DATABASE_URL=… bun packages/db/seed/run.js [--reset | --anchor-date YYYY-MM-DD --days 90]",
  );
  process.exitCode = 2;
} else {
  const db = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    const result = reset ? await resetDemo(db) : await seedDemo(db, options);
    const mt = reset ? null : await seedModernTrade(db);
    console.log(JSON.stringify({ ...result, modernTrade: mt }, null, 2));
  } catch (error) {
    // Do not dump a SQL exception: its query/parameters can contain password hashes.
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(
      message.startsWith("Demo ") ||
        message.startsWith("Reset refused:") ||
        message.startsWith("Invalid sample")
        ? message
        : "Demo command failed; check migrations, ownership dependencies and the test-password key file.",
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
