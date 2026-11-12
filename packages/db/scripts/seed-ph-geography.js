// SP-0170: load PSA PSGC 3Q-2026 regions/provinces/municipalities/barangays and postal codes
// into an already migrated database (idempotent; prints counts only).
// Usage: DATABASE_URL=... bun packages/db/scripts/seed-ph-geography.js
import { createDb } from "../src/client.js";
import { loadPhGeography } from "../src/ph-geography.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");
const db = createDb(url, { max: 1 });
try {
  console.log(JSON.stringify(await loadPhGeography(db)));
} finally {
  await db.close();
}
