import { tx } from "../src/client.js";
import { BATCH, Dataset, at, persist, rowId, todayManila } from "./store.js";
import { company } from "./company.js";
import { stockBook } from "./stock.js";
import { execution } from "./execution.js";
import { vans } from "./vans.js";
import { management } from "./management.js";
import { addCallflowSamples } from "./callflow.js";
import { tpm, seedTpm } from "./tpm.js";
import { integrityFleet } from "./integrity.js";
import { ensureIntegrityFleet } from "./integrity-fleet.js";
import { appendVanOpsPolicies, seedVanOps } from "./vanops.js";
import { towerSamples, extendTowerSamples } from "./tower.js";
import { ensureRetailSamples } from "./retail.js";
import { ensureStorePosSamples } from "./storepos.js";
import { signSamplePlans } from "./sign-plans.js";
export { resetDemo } from "./store.js";

/** @param {{anchorDate?:string,days?:number}} [options] @param {string[]} [hashes] */
export function generateDemo(
  { anchorDate = todayManila(), days = 90 } = {},
  hashes = [],
) {
  const data = new Dataset(anchorDate, days);
  const c = company(data, hashes);
  integrityFleet(data, c);
  // The maintained selling catalog is required by both mobile capture owners.
  for (const store of c.stores) {
    const account = data.add("call_sheet_accounts", store.id, {
      organization_id: "sunpride",
      outlet_id: store.id,
      revision: 1,
      header_account_name: store.name,
      updated_by: "system:sample",
    });
    for (const [ordinal, product] of c.products.entries())
      data.add("call_sheet_account_lines", `${store.id}-${product.id}`, {
        call_sheet_account_id: account.id,
        ordinal,
        product_id: product.id,
      });
  }
  const stock = stockBook(data, c);
  const e = execution(data, c, stock);
  vans(data, c, stock);
  stock.finish();
  management(data, c, e);
  addCallflowSamples(data);
  tpm(data);
  appendVanOpsPolicies(data);
  towerSamples(data, c);
  // Keep the legacy analytics mirrors and ORDERS' canonical centavo facts equal.
  for (const order of data.rows("orders")) {
    order.subtotal_centavos = Math.round(Number(order.subtotal) * 100);
    order.total_centavos = Math.round(Number(order.total) * 100);
    order.amount_known = true;
  }
  // The commercial orders already exist in this historical fixture. Own the
  // trigger-created bridge rows and mark them captured, never replay 90 days.
  for (const activity of data.rows("visit_activities")) {
    if (activity.activity_kind !== "order_intent") continue;
    data.add(
      "order_intent_queue",
      activity.id,
      {
        activity_id: activity.id,
        status: "captured",
      },
      activity.created_at,
    );
  }
  const pastPlanned = data
    .rows("planned_visits")
    .filter((v) => v.service_date < anchorDate).length;
  const pastVisits = data
    .rows("visit_executions")
    .filter((v) => v.service_date < anchorDate && v.state === "completed");
  const currentMonth = anchorDate.slice(0, 7);
  const manifest = data.event("manifest", "manifest", {});
  const summary = {
    batch: BATCH,
    anchorDate,
    days,
    startDate: data.start,
    snapshotAt: data.noon,
    territories: c.territories.length,
    agents: c.agents.length,
    supervisors: c.supervisors.length,
    products: c.products.length,
    stores: c.stores.length,
    plannedCalls: pastPlanned,
    completedCalls: pastVisits.length,
    compliancePct: pastPlanned ? (pastVisits.length / pastPlanned) * 100 : 0,
    productivePct: pastVisits.length
      ? (pastVisits.filter((v) => v.productivity === "verified").length /
          pastVisits.length) *
        100
      : 0,
    orders: data.rows("orders").length,
    salesMtdCentavos: e.monthlySales.get(currentMonth) ?? 0,
    salesTodayCentavos: [...e.dayFacts.values()]
      .filter((f) => f.date === anchorDate)
      .reduce((n, f) => n + f.sales, 0),
    collectionsTodayCentavos: data
      .rows("field_collections")
      .filter((r) => Date.parse(r.created_at) >= at(anchorDate))
      .reduce((n, r) => n + Number(r.amount_minor), 0),
    rows: Object.fromEntries(
      [...data.tables.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([table, rows]) => [table, rows.length]),
    ),
  };
  manifest.details = JSON.stringify({ source: "sample", ...summary });
  return { data, summary };
}

/** F-310 F-316: additive rows must be counted in the original manifest as well as marked.
 * @param {any} db @param {any} summary */
async function retailSummary(db, summary) {
  await ensureRetailSamples(db);
  await ensureStorePosSamples(db);
  // F-020 F-310: the original audit manifest is immutable. Derive the additive
  // inventory from ownership markers on every replay instead of rewriting it.
  const counts =
    await db`select table_name,count(*)::int as n from sample_data_rows where batch=${BATCH} group by table_name`;
  return {
    ...summary,
    rows: Object.fromEntries(
      counts.map((/** @type {any} */ r) => [r.table_name, r.n]),
    ),
  };
}
/**
 * Seed the deterministic demo in one transaction. Identity hashes are intentionally salted
 * by Argon2id; business UUIDs, timestamps, counts and sums are deterministic for the options.
 * Same options are a no-op; changed options require an explicit reset.
 * @param {import('../src/client.js').Db} db
 * @param {{anchorDate?:string,days?:number}} [options]
 */
export async function seedDemo(
  db,
  { anchorDate = todayManila(), days = 90 } = {},
) {
  // Validate before reading the credential or doing any database work.
  new Dataset(anchorDate, days);
  const result = await tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310090)`;
    // F-025: bulk fixture plans must not pay native JIT/startup or spill costs.
    // Keep the tuning local, as reset/read-model work does; all guards still run.
    await t`set local jit=off`;
    await t`set local work_mem='64MB'`;
    const [existing] =
      await t`select a.details from audit_logs a join sample_data_rows m on m.row_id=a.id::text where m.batch=${BATCH} and m.key='audit_logs:manifest'`;
    if (existing) {
      const summary = JSON.parse(existing.details);
      if (summary.anchorDate !== anchorDate || summary.days !== days)
        throw new Error("Demo options changed; run --reset before reseeding");
      await seedTpm(t, anchorDate);
      await ensureIntegrityFleet(t, summary.anchorDate);
      await extendTowerSamples(t, anchorDate, days);
      return { ...(await retailSummary(t, summary)), duplicate: true };
    }
    const [partial] =
      await t`select 1 from sample_data_rows where batch=${BATCH} limit 1`;
    if (partial)
      throw new Error(
        "Incomplete demo ownership markers; run --reset before reseeding",
      );
    const password = (
      await Bun.file(
        `${process.env.HOME}/.sunpride-keys/v2-test-password`,
      ).text()
    ).trim();
    if (password.length < 8)
      throw new Error("Test account password is missing or too short");
    const hashes = [];
    for (let i = 0; i < 7; i++)
      hashes.push(await Bun.password.hash(password, { algorithm: "argon2id" }));
    const { data, summary } = generateDemo({ anchorDate, days }, hashes);
    // Bulk MCPs carry the API approval signature, so every plan opens.
    await signSamplePlans(data);
    await persist(t, data);
    // Read back exact targets and sums in the same transaction, before claiming a seed.
    const [owned] =
      await t`select count(*)::integer as n from sample_data_rows where batch=${BATCH}`;
    if (owned.n !== data.markers.length)
      throw new Error("Demo ownership verification failed");
    const [manifest] =
      await t`select id from audit_logs where id=${rowId("audit_logs", "manifest")}`;
    if (!manifest) throw new Error("Demo manifest verification failed");
    return { ...(await retailSummary(t, summary)), duplicate: false };
  });
  await seedVanOps(db);
  // SP-0170: every sample store gets the client's customer shape (idempotent SQL from 0823).
  await db`select customer_master_backfill('system:sample-seed')`;
  return result;
}
