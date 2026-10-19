import { requireCapability } from "../../core/capabilities.js";
import { rootUnitId, scopeFilterForActor } from "./scope.js";

/** Exact counts; the accessible master set is defined once for the whole summary.
 * @param {import('./model.js').Ctx} c
 */
export async function setupHealth(c) {
  const actor = await requireCapability(c, "admin.manage");
  const { unitIds } = await scopeFilterForActor(c.db, actor);
  const national =
    actor.role === "super_admin" ||
    (actor.role === "admin" && actor.orgUnitId === (await rootUnitId(c.db)));
  const [counts] =
    await c.db`with scope as (select value::uuid as id from jsonb_array_elements_text(${JSON.stringify(unitIds ?? [])}::text::jsonb)),
    visible_outlets as (
      select o.* from outlets o
      left join lateral(select a.territory_id,a.route_id from outlet_assignments a where a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) limit 1) a on true
      left join lateral(select own.org_unit_id from territory_ownerships own where own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now()) limit 1) own on true
      where o.deleted_at is null and o.status='active' and (${unitIds === null} or (case when a.territory_id is null then o.custodian_org_unit_id else own.org_unit_id end) in (select id from scope))
    ), visible_routes as (
      select r.id from routes r where r.deleted_at is null and r.status='active' and r.effective_from<=now() and (r.effective_to is null or r.effective_to>now()) and (${unitIds === null} or exists(select 1 from route_territories rt join territory_ownerships own on own.territory_id=rt.territory_id where rt.route_id=r.id and rt.deleted_at is null and own.deleted_at is null and rt.effective_from<=now() and (rt.effective_to is null or rt.effective_to>now()) and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now()) and own.org_unit_id in (select id from scope)))
    ), people_units as (
      select case when ea.id is not null then ea.org_unit_id when exists(select 1 from employee_assignments old where old.profile_id=p.id and old.deleted_at is null and old.effective_from<=now()) then null else p.org_unit_id end as unit_id
      from profiles p left join lateral(select a.* from employee_assignments a where a.profile_id=p.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) limit 1) ea on true
      where p.deleted_at is null and p.status='active'
    ) select
    (select count(*)::int from people_units p where p.unit_id is null and ${national}) as people,
    (select count(*)::int from visible_outlets o where not exists(select 1 from outlet_assignments a where a.outlet_id=o.id and a.route_id is not null and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()))) as outlets,
    (select count(*)::int from visible_routes r where not exists(select 1 from route_salespeople s where s.route_id=r.id and s.deleted_at is null and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now()))) as routes,
    (select count(*)::int from products p where p.active and p.deleted_at is null and not exists(select 1 from price_list_lines l join price_lists pl on pl.id=l.price_list_id where l.product_id=p.id and pl.status='active' and pl.effective_from<=now() and (pl.effective_to is null or pl.effective_to>now()) and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()))) as prices,
    (select count(*)::int from visible_outlets o where not exists(select 1 from outlet_pins pin where pin.outlet_id=o.id and pin.status='verified' and pin.deleted_at is null and pin.effective_from<=now() and (pin.effective_to is null or pin.effective_to>now()))) as pins`;
  const links = [
    [
      "people",
      "People without a unit",
      "people",
      "/admin?section=people&unassigned=true",
    ],
    [
      "outlets",
      "Outlets without a route",
      "assignments",
      "/admin?section=assignments&unassigned=true",
    ],
    [
      "routes",
      "Routes without a salesperson",
      "routes",
      "/admin?section=routes&unassigned=true",
    ],
    [
      "prices",
      "Products without a price",
      "master-data",
      "/master-data?missingPrice=true",
    ],
    [
      "pins",
      "Stores without a verified pin",
      "outlets",
      "/admin?section=outlets&unverified=true",
    ],
  ];
  return {
    asOf: c.now,
    comparisonNote:
      "Historical setup snapshots are not yet available; no prior-period improvement is claimed. Unassigned people require national access.",
    items: links.map(([key, label, fix, href]) => ({
      key,
      label,
      count:
        (key === "people" && !national) ||
        (key !== "prices" && unitIds !== null && !unitIds.length)
          ? null
          : counts[key],
      target: 0,
      prior: null,
      trend: [],
      fix,
      href,
    })),
  };
}
