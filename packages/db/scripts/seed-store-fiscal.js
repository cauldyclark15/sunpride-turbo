// One-off: give every marked-sample store register its payment types and invoice series (idempotent).
// Usage: DATABASE_URL=... bun packages/db/scripts/seed-store-fiscal.js
import { createDb } from "../src/client.js";
import { seedStoreFiscal } from "../seed/fiscal.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");
const db = createDb(url, { max: 1 });
try {
  console.log(JSON.stringify(await seedStoreFiscal(db)));
} finally {
  await db.end?.();
}
