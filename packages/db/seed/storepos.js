import { completeStorePosSamples } from "./storepos-selling.js";
import { tx } from "../src/client.js";
import { BATCH, Dataset, persist, todayManila } from "./store.js";

/** F-R01: two Cebu sample shops, sharing canonical inventory locations and ownership.
 * Never assigns or changes any real handheld, and never overwrites office-edited masters.
 * @param {any} db */
export async function ensureStorePosSamples(db) {
  return ensureStorePosShops(db);
}

/** Same as ensureStorePosSamples, plus optional extra marked sample shops (test-day fixtures).
 * An extra shop sits in the given unit (e.g. the van seller's) so that seller can be its cashier.
 * @param {any} db @param {{code:string,name:string,orgUnitId:string}[]} [extra] */
export async function ensureStorePosShops(db, extra = []) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(5600560)`;
    const [owner] =
      await t`select p.org_unit_id from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.role='sales' and p.status='active' and p.deleted_at is null order by p.name limit 1`;
    if (!owner?.org_unit_id) return { added: 0 };
    const data = new Dataset(todayManila(), 1);
    for (const [code, name, unit] of [
      ["SAMPLE-CEBU-COLON", "Sample Cebu Colon store", owner.org_unit_id],
      ["SAMPLE-CEBU-MANDAUE", "Sample Cebu Mandaue store", owner.org_unit_id],
      ...extra.map((e) => [e.code, e.name, e.orgUnitId]),
    ]) {
      const [old] =
        await t`select id from inventory_locations where organization_id='sunpride' and code=${code}`;
      if (old) continue;
      const location = data.add("inventory_locations", `storepos:${code}`, {
        organization_id: "sunpride",
        org_unit_id: unit,
        site_code: "CEBU",
        code,
        name,
        type: "store",
        active: true,
        allows_picking: true,
        allows_receiving: true,
        allows_sale: true,
        allows_production: false,
      });
      const register = data.add("store_registers", `storepos:${code}`, {
        location_id: location.id,
        terminal_code: `${code}-01`,
        name: "Sample register 1",
        effective_from: data.epoch,
      });
      data.add("store_register_policies", `storepos:${code}`, {
        register_id: register.id,
        tolerance_centavos: 5000,
        effective_from: data.epoch,
      });
    }
    await persist(t, data);
    await completeStorePosSamples(
      t,
      extra.map((e) => e.code),
    );
    return { added: data.markers.length };
  });
}
