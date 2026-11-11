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
