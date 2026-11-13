// Pure choices behind test-day-fixtures.js, kept apart so they can be tested without the API.
import { outletAt, releasesAt } from "../../../apps/api/src/domains/availability/masters.js";
import { resolveSet } from "../../../apps/api/src/domains/availability/rules.js";

/** The active branch-level (no van, no register) series of `type` in a unit, on ANY registration.
 * The kit used to look only at the unit's first registration and so added a second branch-level
 * series next to the seed's own store series; two at one level leave handhelds without a range (NF-2).
 * Same predicate as the API's tie check (fiscal/series.js createSeries): any not-yet-ended, not-used-up series,
 * including one that starts later, so the kit never asks for a series the API refuses (r4 pos-tills 422).
 * @param {any} db @param {string} unitId @param {string} type */
export async function unitLevelSeries(db, unitId, type) {
  const [row] =
    await db`select s.id,s.prefix from fiscal_series s join fiscal_registrations r on r.id=s.registration_id
      where r.org_unit_id=${unitId} and r.document_type=${type} and s.vehicle_id is null and r.device_id is null
      and s.next_allocate<=s.last_serial and (s.effective_to is null or s.effective_to>now()) order by s.created_at limit 1`;
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

/** FLD-091..094: published activity rules so the phone shows the Merchandising, Promotion, Inventory check
 * and Price check forms. Same lists as the API's provisional defaults (visits/rules.js), published for real:
 * the phone bootstrap carries only published rule rows, never the defaults. */
export const ACTIVITY_RULES = {
  merchandise: [
    { kind: "merchandising", required: true },
    { kind: "price_check", required: false },
  ],
  promotion: [{ kind: "promotion", required: true }],
  audit: [
    { kind: "inventory_check", required: true },
    { kind: "price_check", required: false },
    { kind: "merchandising", required: false },
  ],
};
/** The activity forms the rules above put on the phone. @param {Record<string,{kind:string}[]>} rules */
export function formKinds(rules) {
  return [...new Set(Object.values(rules).flat().map((a) => a.kind))].sort();
}

/** FLD-100: the stores among `outletIds` that resolve a must-stock (MSL) set, by the API's own resolver.
 * Once any MSL framework profile is active it REPLACES the legacy release, and a profile matches only the
 * outlet's governed class (A-D): the sample's "SAMPLE-A" stores therefore get no MSL and no Availability card.
 * @param {any} db @param {string[]} outletIds @param {number} [at] */
export async function stopsWithMsl(db, outletIds, at = Date.now()) {
  const releases = await releasesAt(db, "msl", at);
  const out = [];
  for (const id of outletIds) {
    const outlet = await outletAt(db, id);
    let set = null;
    try {
      set = resolveSet(outlet, releases);
    } catch {
      set = null; // two equal-precedence sets: the call refuses, so no card either
    }
    if (set?.payload?.lines?.length) out.push(outlet.code);
  }
  return out;
}

/** FLD-114: today's stops whose customer has a credit limit with at least `minRoomMinor` left after the
 * open orders the phone counts (submitted .. review_required). Best room first.
 * @param {{code:string,limitMinor:number,openMinor:number}[]} rows @param {number} minRoomMinor */
export function creditRoom(rows, minRoomMinor) {
  return rows
    .map((r) => ({ code: r.code, roomMinor: Number(r.limitMinor) - Number(r.openMinor) }))
    .filter((r) => Number(r.roomMinor) >= minRoomMinor && r.roomMinor > 0)
    .sort((a, b) => b.roomMinor - a.roomMinor || a.code.localeCompare(b.code));
}

/** E2E-012 / SYNC-007: active stores the office added on the web (name "Office Added ...") that sit in no
 * territory yet. The web's Assignments form only takes tomorrow or later; the API takes any instant from now,
 * so the kit places them today. @param {any} db */
export async function officeAddedUnplaced(db) {
  return db`select o.id,o.code,o.name from outlets o where o.name ilike 'Office Added%' and o.status='active' and o.deleted_at is null
    and not exists(select 1 from outlet_assignments a where a.outlet_id=o.id and a.deleted_at is null and (a.effective_to is null or a.effective_to>now()))
    order by o.created_at,o.code limit 20`;
}
