import { readFileSync } from "node:fs";
import { requireCapability } from "../../core/capabilities.js";
import { invalid } from "../../core/errors.js";
import { scopeFilterForActor } from "../org/scope.js";
import { ORDER_ACCESS, ORDER_FROM, scopeParams } from "../orders/access.js";

// Generated from the same vendored polygons the browser renders, never names.
const geography =
  /** @type {{cities:Record<string,[string,string]>,provinces:Record<string,string>,regions:string[],provinceAliases:Record<string,string>}} */ (
    JSON.parse(
      readFileSync(new URL("./areas-geography.json", import.meta.url), "utf8"),
    )
  );
/** Canonical city PSGC chooses its published polygon parents. Only the reviewed
 * pseudo-province aliases apply when no recognized city was stored.
 * @param {any} row */
export function locateArea(row) {
  const parent = geography.cities[row.city];
  const province =
    parent?.[0] ?? geography.provinceAliases[row.province] ?? row.province;
  return {
    ...row,
    city: parent ? row.city : null,
    province: geography.provinces[province] ? province : null,
    region:
      parent?.[1] ??
      geography.provinces[province] ??
      (geography.regions.includes(row.region) ? row.region : null),
  };
}
import {
  bounded,
  manilaDate,
  serviceDate,
  uuid,
  visiblePeople,
  ZERO_UUID,
} from "./model.js";

/** Aggregate the same facts at every geographic level; distinct people are not additive.
 * Unknown sales stay unknown, not zero. No-data means no authorized source rows.
 * @param {any[]} rows */
export function aggregateAreas(rows) {
  /** @type {Map<string,any>} */
  const areas = new Map();
  for (const row of rows) {
    const keys = [
      "all",
      ...[row.region, row.province, row.city].filter(Boolean),
    ];
    for (const code of new Set(keys)) {
      if (!areas.has(code))
        areas.set(code, {
          customers: 0,
          newCustomers: 0,
          sales: 0,
          unknownSales: 0,
          done: 0,
          planned: 0,
          people: new Set(),
          sources: 0,
        });
      const area = areas.get(code);
      for (const key of [
        "customers",
        "newCustomers",
        "sales",
        "unknownSales",
        "done",
        "planned",
        "sources",
      ])
        area[key] += Number(row[key] ?? 0);
      for (const id of row.people ?? []) area.people.add(id);
    }
  }
  return Object.fromEntries(
    [...areas].map(([code, a]) => [
      code,
      {
        ...a,
        people: undefined,
        active: a.people.size,
        sales: a.unknownSales ? null : a.sales,
      },
    ]),
  );
}

/** Website-only geography projection; no addresses inferred from free text or GPS.
 * @param {any} ctx */
export async function areaExplorer(ctx) {
  const actor = await requireCapability(ctx, "location.read");
  await requireCapability(ctx, "outlet.read");
  const db = ctx.db;
  const to = serviceDate(ctx.url.searchParams.get("to") ?? manilaDate(ctx.now));
  const from = serviceDate(
    ctx.url.searchParams.get("from") ?? `${to.slice(0, 7)}-01`,
  );
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
    throw invalid("Choose a period of up to one year");
  const { unitIds } = await scopeFilterForActor(db, actor);
  const unit = ctx.url.searchParams.get("orgUnitId");
  if (unit) {
    uuid(unit);
    await requireCapability(ctx, "location.read", unit);
  }
  const units = unit ? [unit] : (unitIds ?? []);
  const national = !unit && unitIds === null;
  const ids = units.length ? units : [ZERO_UUID];
  const people = (await visiblePeople(ctx))
    .filter((/** @type {any} */ p) => !unit || p.current_unit_id === unit)
    .map((/** @type {any} */ p) => p.id);
  // Sales mirrors /orders' canonical per-source access (including foreign source locations).
  const params = await scopeParams(ctx);
  if (unit) params[0] = { units: [unit] };
  const sales = await db.unsafe(
    `select cp.region_code as region,cp.province_code as province,cp.municipality_code as city,
    coalesce(sum(coalesce(o.total_centavos,(o.total*100)::bigint)) filter(where o.amount_known),0)::text as sales,
    count(*) filter(where not o.amount_known)::int as "unknownSales",count(*)::int as sources
    ${ORDER_FROM} left join customer_profiles cp on cp.outlet_id=o.outlet_id and cp.deleted_at is null
    where ${ORDER_ACCESS} and o.status not in ('draft','rejected','voided')
    and coalesce(o.service_date,(coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date) between $3::date and $4::date
    group by 1,2,3`,
    [...params, from, to],
  );
  const customers =
    await db`select cp.region_code as region,cp.province_code as province,cp.municipality_code as city,
    count(*)::int as customers,count(*)::int as sources,
    count(*) filter(where (o.created_at at time zone 'Asia/Manila')::date between ${from}::date and ${to}::date)::int as "newCustomers"
    from analytics_store_scope s join outlets o on o.id=s.id left join customer_profiles cp on cp.outlet_id=s.id and cp.deleted_at is null
    where (${national} or s.owner_unit_id in ${db(ids)}) and o.status!='inactive'
    and (${actor.role !== "sales"} or exists(select 1 from territory_salespeople ts where ts.territory_id=s.territory_id and ts.profile_id=${actor.profileId} and ts.deleted_at is null and ts.effective_from<=now() and (ts.effective_to is null or ts.effective_to>now())))
    group by 1,2,3`;
  const visits = people.length
    ? await db`with facts as (
    select v.outlet_id,v.assignee_profile_id,1 as planned,0 as done from planned_visits v
    join coverage_plans cp on cp.id=v.plan_id and cp.status in ('approved','active') and cp.approval_signature is not null
    where v.deleted_at is null and v.status='planned' and v.service_date between ${from}::date and ${to}::date and v.assignee_profile_id in ${db(people)}
    union all
    select v.outlet_id,v.assignee_profile_id,0,case when v.state in ('completed','checked-out') then 1 else 0 end from visit_executions v
    where v.deleted_at is null and v.state!='cancelled' and v.service_date between ${from}::date and ${to}::date and v.assignee_profile_id in ${db(people)} and (${national} or v.org_unit_id in ${db(ids)})
  ) select cp.region_code as region,cp.province_code as province,cp.municipality_code as city,
    sum(f.planned)::int as planned,sum(f.done)::int as done,count(*)::int as sources,
    coalesce(jsonb_agg(distinct f.assignee_profile_id) filter(where f.planned=0),'[]'::jsonb) as people
    from facts f join analytics_store_scope s on s.id=f.outlet_id left join customer_profiles cp on cp.outlet_id=f.outlet_id and cp.deleted_at is null
    where (${national} or s.owner_unit_id in ${db(ids)}) group by 1,2,3`
    : [];
  const facts = bounded([...sales, ...customers, ...visits], 6000);
  // Geometry-derived parents reconcile NCR pseudo-provinces and SGA without
  // changing customer records, business ownership or authorization.
  for (let i = 0; i < facts.length; i++) facts[i] = locateArea(facts[i]);
  const unlocated =
    aggregateAreas(facts.filter((/** @type {any} */ r) => !r.region)).all ??
    null;
  return {
    from,
    to,
    areas: aggregateAreas(facts),
    unlocated,
    definition:
      "Booked sales exclude draft, rejected and voided orders. Customers are current, non-inactive records. Visits are completed / planned; active salesmen have recorded visits in the period. New customers use the date added. Geography uses the stored customer address, not phone location.",
  };
}
