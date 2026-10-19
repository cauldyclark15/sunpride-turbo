import { ApiError } from "../../core/errors.js";
import { activeAt, get, history, instant, ms, rule } from "./model.js";

/** @typedef {import('@sunpride/db/client').Db} Db */
/** @typedef {import('../../core/context.js').Actor} Actor */

/** Effective edges, never scheduled parent projections. Reject corrupt/oversized trees. @param {Db} db @param {number} [asOf] */
export async function topology(db, asOf = Date.now()) {
  instant(asOf);
  /** @type {import('./model.js').Row[]} */
  const all =
    await db`select * from org_units where organization_id = 'sunpride' and deleted_at is null order by code limit 501`;
  if (all.length > 500) rule("Organization exceeds 500 units", "overflow");
  const units = all.filter(
    (u) =>
      activeAt(u, asOf) && (u.status === "active" || u.effective_to != null),
  );
  /** @type {import('./model.js').Row[]} */
  const edges =
    await db`select * from org_unit_parent_edges where deleted_at is null and effective_from <= ${new Date(asOf)} order by effective_from desc`;
  const ids = new Set(units.map((u) => u.id));
  /** @type {import('./model.js').Row[]} */
  const tree = units.map((u) => {
    const prior = edges.filter((e) => e.unit_id === u.id);
    const effective = prior.filter((e) => activeAt(e, asOf));
    if (effective.length > 1) rule("Overlapping parents");
    const parent_id =
      effective[0]?.parent_id ?? (prior.length ? null : u.parent_id);
    if (parent_id && !ids.has(parent_id)) rule("Orphaned organization unit");
    return { ...u, parent_id };
  });
  if (
    tree.length &&
    (tree.filter((u) => !u.parent_id).length !== 1 ||
      tree.find((u) => !u.parent_id)?.code !== "SUNPRIDE")
  )
    rule("Invalid organization root");
  const byId = new Map(tree.map((u) => [u.id, u]));
  for (const u of tree) {
    const seen = new Set();
    /** @type {import('./model.js').Row|undefined} */ let cursor = u;
    while (cursor) {
      if (seen.has(cursor.id)) rule("Organization cycle");
      seen.add(cursor.id);
      cursor = byId.get(cursor.parent_id);
    }
  }
  return tree;
}

/** @param {Db} db @param {string} root @param {number} [asOf] @returns {Promise<string[]>} */
export async function subtree(db, root, asOf = Date.now()) {
  const tree = await topology(db, asOf);
  if (!tree.some((u) => u.id === root)) return [];
  const ids = new Set([root]);
  for (let i = 0; i < tree.length; i++) {
    const before = ids.size;
    for (const u of tree) if (ids.has(u.parent_id)) ids.add(u.id);
    if (before === ids.size) break;
  }
  return [...ids];
}

/** Current scope always gates historical reads. @param {Db} db @param {Actor} actor @returns {Promise<{unitIds:string[]|null}>} */
export async function scopeFilterForActor(db, actor) {
  if (!actor) throw new ApiError("unauthenticated", 401, "Sign in required");
  if (["super_admin", "analyst"].includes(actor.role)) return { unitIds: null };
  return { unitIds: actor.orgUnitId ? await subtree(db, actor.orgUnitId) : [] };
}

/** @param {Db} db */
export async function rootUnitId(db) {
  return (await topology(db)).find((u) => !u.parent_id)?.id ?? null;
}

/** @param {Db} db @param {string} territoryId @param {number} [asOf] */
export async function territoryOwnerUnit(db, territoryId, asOf = Date.now()) {
  const owners = (
    await history(db, "territory_ownerships", "territory_id", territoryId)
  ).filter((r) => !r.deleted_at && activeAt(r, asOf));
  if (owners.length > 1) rule("Overlapping territory owners");
  return /** @type {string|null} */ (owners[0]?.org_unit_id ?? null);
}

/** As-of attribution only; callers must separately gate the CURRENT owner. Fail closed if an assigned territory has no owner. @param {Db} db @param {string} outletId @param {number} asOf @returns {Promise<string|null>} */
export async function outletOwnerUnit(db, outletId, asOf) {
  instant(asOf);
  const outlet = await get(db, "outlets", outletId);
  const rows = (
    await history(db, "outlet_assignments", "outlet_id", outletId)
  ).filter((r) => !r.deleted_at && activeAt(r, asOf));
  if (rows.length > 1) rule("Overlapping outlet assignments");
  if (!rows.length) return outlet.custodian_org_unit_id;
  const owner = await territoryOwnerUnit(db, rows[0].territory_id, asOf);
  if (!owner) rule("Assigned territory has no owner");
  return owner;
}

/** Resolve the effective person, while preserving inactive denial in loadProfile. @param {Db} db @param {any} person @param {number} [asOf] */
export async function personAt(db, person, asOf = Date.now()) {
  const rows = await history(
    db,
    "employee_assignments",
    "profile_id",
    person.id,
  );
  const current = rows.filter((r) => !r.deleted_at && activeAt(r, asOf));
  if (current.length > 1) rule("Overlapping employee assignments");
  if (!rows.length) return person;
  if (!current.length)
    return rows.every((r) => ms(r.effective_from) > asOf)
      ? person
      : { ...person, org_unit_id: null };
  return {
    ...person,
    ...current[0],
    id: person.id,
    user_id: person.user_id,
    status: person.status,
    scope_epoch: `${person.scope_epoch}:${current[0].id}:${ms(current[0].effective_from)}`,
  };
}
