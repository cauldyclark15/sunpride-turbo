import { completeStorePosSamples } from "./storepos-selling.js";
import { tx } from "../src/client.js";
import { BATCH, Dataset, persist, todayManila } from "./store.js";

export const SAMPLE_STORE_CASHIER = "van@sunpride.test";

/** F-R01: two Cebu sample shops, sharing canonical inventory locations and ownership.
 * Never assigns or changes any real handheld, and never overwrites office-edited masters.
 * @param {any} db */
export async function ensureStorePosSamples(db) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(5600560)`;
    // POS-001/E2E-002: the test pack's store cashier is the original sample van seller on the same handheld, and the
    // office only pairs a handheld, register and cashier inside one unit. Own the sample shops by that seller's unit.
    const [owner] =
      await t`select p.org_unit_id from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.role='sales' and p.status='active' and p.deleted_at is null and p.org_unit_id is not null order by (p.email=${SAMPLE_STORE_CASHIER}) desc,p.name limit 1`;
    if (!owner?.org_unit_id) return { added: 0 };
    // Older sample databases placed the shops in another unit. Move an untouched marked-sample shop (no cashier
    // session or assignment ever) so re-seeding repairs it; a used shop keeps its history and unit.
    await t`update inventory_locations l set org_unit_id=${owner.org_unit_id},updated_at=now() from sample_data_rows m where m.table_name='inventory_locations' and m.row_id=l.id::text and m.batch=${BATCH} and l.type='store' and l.code in ('SAMPLE-CEBU-COLON','SAMPLE-CEBU-MANDAUE') and l.org_unit_id<>${owner.org_unit_id} and not exists (select 1 from store_registers r join store_shifts h on h.register_id=r.id where r.location_id=l.id) and not exists (select 1 from store_registers r join store_cashier_assignments a on a.register_id=r.id where r.location_id=l.id)`;
    await t`update outlets o set custodian_org_unit_id=l.org_unit_id,updated_at=now() from store_registers r join inventory_locations l on l.id=r.location_id join sample_data_rows m on m.table_name='inventory_locations' and m.row_id=l.id::text and m.batch=${BATCH} join sample_data_rows om on om.table_name='outlets' and om.batch=${BATCH} where o.id=r.outlet_id and om.row_id=o.id::text and l.code in ('SAMPLE-CEBU-COLON','SAMPLE-CEBU-MANDAUE') and o.custodian_org_unit_id is distinct from l.org_unit_id`;
    const data = new Dataset(todayManila(), 1);
    for (const [code, name] of [
      ["SAMPLE-CEBU-COLON", "Sample Cebu Colon store"],
      ["SAMPLE-CEBU-MANDAUE", "Sample Cebu Mandaue store"],
    ]) {
      const [old] =
        await t`select id from inventory_locations where organization_id='sunpride' and code=${code}`;
      if (old) continue;
      const location = data.add("inventory_locations", `storepos:${code}`, {
        organization_id: "sunpride",
        org_unit_id: owner.org_unit_id,
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
    await completeStorePosSamples(t);
    return { added: data.markers.length };
  });
}
