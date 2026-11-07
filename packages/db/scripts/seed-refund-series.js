// One-off for live: give every marked-sample store register and vehicle its credit-memo (refund) number series, so refunds
// can be numbered. Idempotent and additive only: a unit or vehicle that already has a credit-memo series (even office-edited
// or disabled) is left exactly as it is, so a second run prints {"stores":0,"vehicles":0}. Never raw SQL on a live database.
//   DRY RUN (writes nothing, prints what would be made):  DATABASE_URL=... bun packages/db/scripts/seed-refund-series.js --dry-run
//   REAL RUN:                                              DATABASE_URL=... bun packages/db/scripts/seed-refund-series.js
// Refunds stay off for a unit until it has this series (the phone shows no refund button without credit-memo numbers).
import { createDb } from "../src/client.js";
import { seedRefundSeries } from "../seed/fiscal.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");
const dryRun = process.argv.includes("--dry-run");
const db = createDb(url, { max: 1 });
try {
  console.log(JSON.stringify(await seedRefundSeries(db, { dryRun })));
} finally {
  await db.end?.();
}
