import { ApiError } from "../../core/errors.js";
import { bounded, outletAt } from "./model.js";
/**
 * Eligible visible assigned stores. Authorization always follows today's persisted owner;
 * neither a shared customer nor a historic signed territory grants current access.
 * @param {any} ctx @param {any} plan
 */
export async function eligibleOutlets(ctx, plan) {
  const db = ctx.db;
  const rows =
    await db`select distinct o.* from outlets o join outlet_assignments a on a.outlet_id=o.id
    where o.deleted_at is null and o.status in ('active','prospect') and a.deleted_at is null
      and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
      and (exists(select 1 from coverage_plan_outlets po where po.plan_id=${plan.id} and po.territory_id=a.territory_id)
        or exists(select 1 from territory_salespeople tp where tp.territory_id=a.territory_id and tp.profile_id=${plan.assignee_profile_id} and tp.deleted_at is null and tp.effective_from<=${new Date(ctx.now)} and (tp.effective_to is null or tp.effective_to>${new Date(ctx.now)}))
        or exists(select 1 from route_salespeople rp where rp.route_id=a.route_id and rp.profile_id=${plan.assignee_profile_id} and rp.deleted_at is null and rp.effective_from<=${new Date(ctx.now)} and (rp.effective_to is null or rp.effective_to>${new Date(ctx.now)}))) order by o.code`;
  const result = [];
  for (const row of rows) {
    try {
      const live = await outletAt(ctx, row.id, ctx.now);
      result.push(live);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
    }
  }
  return bounded(result, "Eligible outlet roster");
}
/** @param {any} ctx @param {any} p @param {any[]} projected @param {any[]} planOutlets */
export async function routeProjection(ctx, p, projected, planOutlets) {
  const eligible = await eligibleOutlets(ctx, p),
    db = ctx.db;
  /** @type {Map<string,any>} */ const groups = new Map();
  const group = async (
    /** @type {string|undefined} */ territoryId,
    /** @type {string|undefined} */ routeId,
    /** @type {any} */ snapshot = {},
  ) => {
    const key = `${territoryId ?? "none"}:${routeId ?? "none"}`;
    if (!groups.has(key)) {
      const [t] = territoryId
        ? await db`select code from territories where id=${territoryId}`
        : [];
      const [r] = routeId
        ? await db`select code from routes where id=${routeId}`
        : [];
      groups.set(key, {
        territoryId,
        routeId,
        territoryCode: snapshot.territoryCode ?? t?.code ?? "No territory",
        routeCode: snapshot.routeCode ?? r?.code ?? "No route",
        slotCount: 0,
        visitCount: 0,
        outlets: new Map(),
      });
    }
    return groups.get(key);
  };
  for (const o of planOutlets) {
    const first = projected.find((r) => r.outletId === o.outlet_id);
    const live = await outletAt(ctx, o.outlet_id, ctx.now);
    const g = await group(
      first?.territoryId ?? o.territory_id,
      first?.routeId ?? o.route_id,
      first ?? {},
    );
    g.outlets.set(o.outlet_id, {
      outletCode: first?.outletCode ?? live.outlet.code,
      name: first?.name ?? live.outlet.name,
      frequency: o.frequency,
      covered: true,
    });
  }
  for (const live of eligible) {
    const g = await group(
      live.assignment.territory_id,
      live.assignment.route_id,
    );
    if (!planOutlets.some((o) => o.outlet_id === live.outlet.id))
      g.outlets.set(live.outlet.id, {
        outletCode: live.outlet.code,
        name: live.outlet.name,
        covered: false,
      });
  }
  for (const row of projected.filter((r) => r.kind === "outlet_visit")) {
    const g = await group(row.territoryId, row.routeId, row);
    g.slotCount++;
    if (
      ["active", "superseded"].includes(p.status)
        ? row.visitStatus === "planned"
        : true
    )
      g.visitCount++;
  }
  return [...groups.values()]
    .filter((g) => g.outlets.size || g.slotCount)
    .map((g) => {
      const members = [...g.outlets.values()];
      return {
        ...g,
        outlets: members,
        coveredCount: members.filter((x) => x.covered).length,
        uncoveredCount: members.filter((x) => !x.covered).length,
      };
    });
}
