#!/usr/bin/env bun
import { createDb, tx } from "../src/client.js";
import { seedSpecMasters } from "./spec-masters.js";
import { seedFieldHierarchy } from "./field-hierarchy.js";
import { seedDemo, resetDemo } from "./index.js";
import { seedSapDemo } from "./sap.js";
import { seedDistributors } from "./distributors.js";
import { seedFiscal } from "./fiscal.js";
import { seedAvailability } from "./availability.js";

const args = process.argv.slice(2);
let reset = false;
let sap = false;
let distributors = false;
/** @type {{anchorDate?:string,days?:number}} */
const options = {};
let invalid = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sap") sap = true;
  else if (args[i] === "--distributors") distributors = true;
  else if (args[i] === "--reset") reset = true;
  else if (args[i] === "--anchor-date" && args[i + 1])
    options.anchorDate = args[++i];
  else if (args[i] === "--days" && args[i + 1])
    options.days = Number(args[++i]);
  else invalid = true;
}
if (
  !process.env.DATABASE_URL ||
  invalid ||
  (reset && (sap || distributors)) ||
  (reset && Object.keys(options).length > 0)
) {
  console.error(
    "Usage: DATABASE_URL=… bun packages/db/seed/run.js [--reset | --anchor-date YYYY-MM-DD --days 90] [--sap] [--distributors]",
  );
  process.exitCode = 2;
} else {
  const db = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    const result = reset ? await resetDemo(db) : await seedDemo(db, options);
    if (!reset) await seedAvailability(db, options.anchorDate);
    if (!reset) await seedFiscal(db);
    if (!reset)
      await tx(db, async (t) => {
        await seedFieldHierarchy(t);
        await seedSpecMasters(t);
      });
    if (sap) console.log(JSON.stringify(await seedSapDemo(db), null, 2));
    const distributorSamples = distributors
      ? await seedDistributors(db, { anchorDate: options.anchorDate })
      : null;
    console.log(JSON.stringify({ ...result, distributorSamples }, null, 2));
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
