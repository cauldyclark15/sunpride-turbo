#!/usr/bin/env bun
import { createDb, tx } from "../src/client.js";
import { seedSpecMasters } from "./spec-masters.js";
import { seedFieldHierarchy } from "./field-hierarchy.js";
import { seedDemo, resetDemo } from "./index.js";
import { seedSapDemo } from "./sap.js";
import { seedDistributors } from "./distributors.js";
import { seedFiscal } from "./fiscal.js";
import { seedAvailability } from "./availability.js";
import { seedModernTrade } from "./modern-trade.js";
import { ensurePartnerSamples } from "./partners.js";
import { seedCoverageSpec } from "./coverage-spec.js";
import { seedProductiveSpec } from "./productive-spec.js";
import { seedWorkforceSpec } from "./workforce-spec.js";
import { seedDormancySpec } from "./dormancy-spec.js";

const args = process.argv.slice(2);
let reset = false;
let sap = false;
let distributors = false;
let spec = false;
/** @type {{anchorDate?:string,days?:number}} */
const options = {};
let invalid = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--spec") spec = true;
  else if (args[i] === "--sap") sap = true;
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
  (reset && (sap || distributors || spec)) ||
  (reset && Object.keys(options).length > 0)
) {
  console.error(
    "Usage: DATABASE_URL=… bun packages/db/seed/run.js [--reset | --anchor-date YYYY-MM-DD --days 90] [--sap] [--distributors] [--spec]",
  );
  process.exitCode = 2;
} else {
  const db = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    const result = reset ? await resetDemo(db) : await seedDemo(db, options);
    const coverageSpec = spec ? await seedCoverageSpec(db) : null;
    const productiveSpec = spec ? await seedProductiveSpec(db) : null;
    const workforceSpec = spec ? await seedWorkforceSpec(db) : null;
    const dormancySpec = spec ? await seedDormancySpec(db) : null;
    if (spec)
      result.partnerSamples = await ensurePartnerSamples(db, {
        date: options.anchorDate,
      });
    const mt = spec ? await seedModernTrade(db) : null;
    if (spec) await seedAvailability(db, options.anchorDate);
    if (spec) await seedFiscal(db);
    if (spec)
      await tx(db, async (t) => {
        await seedFieldHierarchy(t);
        await seedSpecMasters(t);
      });
    if (sap) console.log(JSON.stringify(await seedSapDemo(db), null, 2));
    const distributorSamples = distributors
      ? await seedDistributors(db, { anchorDate: options.anchorDate })
      : null;
    console.log(
      JSON.stringify(
        {
          ...result,
          distributorSamples,
          modernTrade: mt,
          coverageSpec,
          productiveSpec,
          workforceSpec,
          dormancySpec,
        },
        null,
        2,
      ),
    );
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
