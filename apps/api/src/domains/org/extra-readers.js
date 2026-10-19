import { requireCapability } from "../../core/capabilities.js";
import { access, list, readHistory } from "./readers.js";
import {
  activeAt,
  dto,
  get,
  history,
  instant,
  integer,
  rule,
  uuid,
} from "./model.js";
import {
  scopeFilterForActor,
  subtree,
  territoryOwnerUnit,
  topology,
} from "./scope.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */
/** @param {Ctx} c @param {Row} p */
export async function supervisorOptions(c, p) {
  await requireCapability(c, "admin.manage", uuid(p.orgUnitId));
  const tree = await topology(c.db);
  const parent = new Map(tree.map((u) => [u.id, u.parent_id]));
  const ancestors = [];
  let cursor = p.orgUnitId;
  while (cursor) {
    ancestors.push(cursor);
    cursor = parent.get(cursor);
  }
  return list(c, "people", { ...p, supervisorUnits: ancestors });
}
/** @param {Ctx} c @param {'route'|'territory'} kind @param {Row} p */
export async function roster(c, kind, p) {
  const id = uuid(kind === "route" ? p.routeId : p.territoryId),
    at = p.asOf ?? c.now;
  instant(at);
  await access(
    c,
    kind === "route" ? "routes" : "territories",
    id,
    kind === "route" ? "route.read" : "territory.read",
  );
  const rows = await history(c.db, "outlet_assignments", `${kind}_id`, id);
  /** @type {Row[]} */ const result = [];
  for (const row of rows.filter((r) => !r.deleted_at && activeAt(r, at))) {
    try {
      await access(c, "outlets", row.outlet_id, "outlet.read");
      if (at > c.now) {
        const owner = await territoryOwnerUnit(c.db, row.territory_id, at);
        if (!owner) rule("Future owner missing");
        await requireCapability(c, "outlet.read", owner);
      }
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 403)
        continue;
      throw error;
    }
    const outlet = await get(c.db, "outlets", row.outlet_id),
      territory = await get(c.db, "territories", row.territory_id);
    result.push({
      ...dto(row),
      outletName: outlet.name,
      outletCode: outlet.code,
      territoryName: territory.name,
      routeName: row.route_id
        ? (await get(c.db, "routes", row.route_id)).name
        : undefined,
    });
  }
  return result.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}
/** Status feed scopes through persisted current ownership and the proposer's person. @param {Ctx} c @param {Row} p */
export async function notifications(c, p) {
  const actor = await requireCapability(c, "outlet.read");
  const { unitIds } = await scopeFilterForActor(c.db, actor);
  const limit = integer(p.limit ?? 10, 1, 100);
  /** @type {Row[]} */ const rows =
    await c.db`select e.* from outlet_enrolment_events e join outlets o on o.id=e.outlet_id
    left join lateral(select a.territory_id from outlet_assignments a where a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) limit 1) a on true
    left join lateral(select own.org_unit_id from territory_ownerships own where own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now()) limit 1) own on true
    where o.deleted_at is null and (${unitIds === null} or (case when a.territory_id is null then o.custodian_org_unit_id else own.org_unit_id end) in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(unitIds ?? [])}::text::jsonb))) and (${actor.role !== "sales"} or e.proposed_by_profile_id=${actor.profileId}) order by e.created_at desc,e.id desc limit ${limit}`;
  return rows.map(dto);
}
