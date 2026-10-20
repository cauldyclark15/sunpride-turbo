#!/usr/bin/env bun
// Usage: DATABASE_URL=… bun packages/db/seed/programme-run.js
// Loads Sunpride's Phase 1 feature list and our status. Safe to repeat.
import { createDb } from "../src/client.js";
import { seedProgramme } from "./programme.js";

if (!process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL=… bun packages/db/seed/programme-run.js");
  process.exitCode = 2;
} else {
  const db = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    console.log(JSON.stringify(await seedProgramme(db)));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Programme seed failed",
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
