import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { ensureStorePosSamples } from "../../../packages/db/seed/storepos.js";
import { BATCH } from "../../../packages/db/seed/store.js";

/** POS-001 / E2E-002: the office pairs handheld, register and cashier only inside one unit, and the test pack's store
 * cashier is the original sample van seller. The sample shops must therefore belong to that seller's unit. */
const SAMPLE_STORE_CASHIER = "van@sunpride.test";
/** @type {any} */ let h;
const agentUnit = crypto.randomUUID(),
  vanUnit = crypto.randomUUID();
/** @param {string} id @param {string} name @param {string} email @param {string} unit */
async function salesPerson(id, name, email, unit) {
  await h.db`insert into profiles(id,auth_subject,name,email,role,status,org_unit_id) values(${id},${"sample:" + id},${name},${email},'sales','active',${unit})`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values(${BATCH},'profiles',${id},${"seed-unit-" + email})`;
}
/** @returns {Promise<any[]>} */
const shops = () =>
  h.db`select l.code,l.org_unit_id from inventory_locations l where l.type='store' and l.code in ('SAMPLE-CEBU-COLON','SAMPLE-CEBU-MANDAUE') order by l.code`;

beforeAll(async () => {
  h = await startHarness();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${agentUnit},'sunpride','SEED-T1','Sample T1','national','active',now()-interval '1 day'),(${vanUnit},'sunpride','SEED-T2','Sample T2','national','active',now()-interval '1 day')`;
  // "Sample Ana Mercado" sorts before the van seller, which is how the shops used to land in the wrong unit.
  await salesPerson(
    crypto.randomUUID(),
    "Sample Ana Mercado",
    "agent@sunpride.test",
    agentUnit,
  );
  await salesPerson(
    crypto.randomUUID(),
    "Sample Paolo Van Seller",
    SAMPLE_STORE_CASHIER,
    vanUnit,
  );
});
afterAll(async () => h?.close?.());

test("POS-001: both sample shops are seeded in the sample van seller's unit", async () => {
  await ensureStorePosSamples(h.db);
  const rows = await shops();
  expect(rows.map((r) => r.code)).toEqual([
    "SAMPLE-CEBU-COLON",
    "SAMPLE-CEBU-MANDAUE",
  ]);
  for (const r of rows) expect(r.org_unit_id).toBe(vanUnit);
});

test("POS-001: re-seeding moves an untouched old-unit shop, but never a shop that has a cashier session", async () => {
  await h.db`update inventory_locations set org_unit_id=${agentUnit} where code in ('SAMPLE-CEBU-COLON','SAMPLE-CEBU-MANDAUE')`;
  const [cashier] =
    await h.db`select id from profiles where email='agent@sunpride.test'`;
  const [used] =
    await h.db`select r.id from store_registers r join inventory_locations l on l.id=r.location_id where l.code='SAMPLE-CEBU-MANDAUE'`;
  await h.db`insert into store_cashier_assignments(register_id,profile_id,effective_from) values(${used.id},${cashier.id},now())`;
  await ensureStorePosSamples(h.db);
  const rows = Object.fromEntries(
    (await shops()).map((r) => [r.code, r.org_unit_id]),
  );
  expect(rows["SAMPLE-CEBU-COLON"]).toBe(vanUnit);
  expect(rows["SAMPLE-CEBU-MANDAUE"]).toBe(agentUnit);
});
