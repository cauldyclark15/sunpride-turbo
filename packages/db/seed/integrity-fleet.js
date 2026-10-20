import { tx } from "../src/client.js";
import { Dataset, insertRows } from "./store.js";
import { company } from "./company.js";
import { integrityFleet } from "./integrity.js";

/** F-021 additive upgrade for an already-seeded demo. Never resets, updates assets, or rewrites people/credentials.
 * Every row is explicitly sample-owned; the normal FK-aware reset keeps outside dependencies protected.
 * @param {import('../src/client.js').Db} db @param {string} date
 * @param {import('./company.js').Company} [existingCompany]
 */
export async function ensureIntegrityFleet(db, date, existingCompany) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310090)`;
    const data = new Dataset(date, 1);
    const c = existingCompany ?? company(new Dataset(date, 1), []);
    integrityFleet(data, c);
    const candidates = data.rows("fleet_asset_versions");
    const existing = new Set(
      (
        await t`select id from fleet_asset_versions where id in ${t(candidates.map((r) => r.id))}`
      ).map((/** @type {any} */ r) => r.id),
    );
    const missing = candidates.filter((r) => !existing.has(r.id));
    if (!missing.length) return { added: 0 };
    const people = new Map(
      (
        await t`select id,org_unit_id from profiles where id in ${t(missing.map((r) => r.assigned_profile_id ?? null))} and deleted_at is null and status='active'`
      ).map((/** @type {any} */ p) => [p.id, p]),
    );
    const units = new Set(
      (
        await t`select id from org_units where deleted_at is null and status='active'`
      ).map((/** @type {any} */ u) => u.id),
    );
    const rows = missing.filter((r) => {
      if (r.assigned_profile_id) {
        const person = people.get(r.assigned_profile_id);
        if (!person) return false;
        r.org_unit_id = person.org_unit_id;
      }
      return units.has(r.org_unit_id);
    });
    if (!rows.length) return { added: 0 };
    const ids = new Set(rows.map((r) => r.id));
    await insertRows(t, "fleet_asset_versions", rows);
    await insertRows(
      t,
      "sample_data_rows",
      data.markers.filter((m) => ids.has(m.row_id)),
    );
    return { added: rows.length };
  });
}
