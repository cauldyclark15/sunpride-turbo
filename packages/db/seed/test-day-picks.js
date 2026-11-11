// Pure choices behind test-day-fixtures.js, kept apart so they can be tested without the API.

/** The active branch-level (no van, no register) series of `type` in a unit, on ANY registration.
 * The kit used to look only at the unit's first registration and so added a second branch-level
 * series next to the seed's own store series; two at one level leave handhelds without a range (NF-2).
 * @param {any} db @param {string} unitId @param {string} type */
export async function unitLevelSeries(db, unitId, type) {
  const [row] =
    await db`select s.id,s.prefix from fiscal_series s join fiscal_registrations r on r.id=s.registration_id
      where r.org_unit_id=${unitId} and r.document_type=${type} and s.vehicle_id is null and r.device_id is null
      and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now()) order by s.created_at limit 1`;
  return row ?? null;
}

/** A store's POS cashier must work in the store's unit. Pick the first preferred tester who does.
 * @param {string} storeUnitId @param {{email:string,org_unit_id:string}[]} people */
export function cashierFor(storeUnitId, people) {
  return people.find((p) => p && p.org_unit_id === storeUnitId)?.email ?? null;
}

/** SAP owns the name and address of every outlet it sends (integration replicas.js `update outlets set name=... where code=...`),
 * so a rename of a SAP-keyed outlet is overwritten by the next masters pull. Returns the codes SAP currently sends.
 * @param {any} db @param {string[]} codes */
export async function sapOwnedOutletCodes(db, codes) {
  if (!codes.length) return new Set();
  const rows =
    await db`select distinct payload->'data'->>'code' as code from sap_replicas where kind='outlet' and deleted_at is null and payload->'data'->>'code' in ${db(codes)}`;
  return new Set(rows.map((/** @type {any} */ r) => r.code));
}

/** The accent/punctuation names that still need an outlet SAP cannot rename. A name held only by a SAP-keyed
 * outlet counts as missing: the kit used to rename SAP sample outlets and SAP put the old names back (r3).
 * @param {any} db @param {string[]} names */
export async function accentedNamesMissing(db, names) {
  const have =
    await db`select name,code from outlets where name in ${db(names)} and deleted_at is null and status='active'`;
  const sap = await sapOwnedOutletCodes(
    db,
    have.map((/** @type {any} */ r) => r.code),
  );
  const kept = new Set(
    have
      .filter((/** @type {any} */ r) => !sap.has(r.code))
      .map((/** @type {any} */ r) => r.name),
  );
  return names.filter((n) => !kept.has(n));
}
