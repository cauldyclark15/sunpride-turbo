// SP-0170: re-apply Sunpride's customer reference lists from the committed client JSON
// (idempotent upsert; rows dropped from the file are deactivated, never deleted).
// Migration 0820 already loads them; run this after Sunpride sends an updated workbook and
// the JSON is regenerated. Usage: DATABASE_URL=... bun packages/db/scripts/seed-customer-reference.js
import { createDb } from "../src/client.js";
import { loadCustomerReference } from "../src/customer-reference.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");
const db = createDb(url, { max: 1 });
try {
  console.log(JSON.stringify(await loadCustomerReference(db)));
} finally {
  await db.close();
}
