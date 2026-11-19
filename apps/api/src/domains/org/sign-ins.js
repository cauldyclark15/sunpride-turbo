import { requireCapability } from "../../core/capabilities.js";
import { forbidden, invalid } from "../../core/errors.js";
import { manilaBusinessDate } from "../../core/docnum.js";
import { uuid } from "./model.js";
import { scopeFilterForActor, subtree, topology } from "./scope.js";

export const SIGN_IN_ROLES = ["super_admin", "admin", "manager"];
export const SIGN_IN_APPS = [
  "web",
  "field-android",
  "van-android",
  "field-ios",
  "office-ios",
];
const ROLES = [
  "super_admin",
  "admin",
  "manager",
  "operations",
  "approver",
  "sales",
  "analyst",
  "viewer",
];

/** @param {unknown} value @param {number} now */
export function signInDay(value, now) {
  const date = value ?? manilaBusinessDate(now);
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw invalid("Choose a valid date");
  const start = new Date(`${date}T00:00:00+08:00`);
  if (
    !Number.isFinite(+start) ||
    manilaBusinessDate(+start) !== date ||
    date > manilaBusinessDate(now)
  )
    throw invalid("Choose today or an earlier date");
  return { date, start, end: new Date(+start + 86_400_000) };
}

/** Read-only session report; current person/branch ownership gates historical dates too.
 * @param {import('./model.js').Ctx} c @param {Record<string,any>} p */
export async function signIns(c, p) {
  const actor = await requireCapability(c, "people.read");
  if (!SIGN_IN_ROLES.includes(actor.role))
    throw forbidden("Sign-ins are for administrators and managers");
  const { date, start, end } = signInDay(p.date, c.now);
  if (p.role && !ROLES.includes(p.role)) throw invalid("Choose a valid role");
  if (p.app && !SIGN_IN_APPS.includes(p.app))
    throw invalid("Choose a valid app");
  const { unitIds } = await scopeFilterForActor(c.db, actor);
  if (unitIds !== null && !unitIds.length)
    throw forbidden("Your access has no organizational scope");
  const tree = await topology(c.db);
  const units = tree.filter((u) => unitIds === null || unitIds.includes(u.id));
  let selected = unitIds;
  if (p.orgUnitId) {
    uuid(p.orgUnitId);
    if (!units.some((u) => u.id === p.orgUnitId))
      throw forbidden("Choose a branch within your access");
    const descendants = await subtree(c.db, p.orgUnitId);
    selected = descendants.filter(
      (id) => unitIds === null || unitIds.includes(id),
    );
  }
  const db = c.db;
  // Resolve prospective assignments, including an ended assignment with no successor, just as personAt does.
  // Aggregate before the person bound: no session-prefix cap and no silently incomplete export.
  /** @type {Record<string,any>[]} */
  const rows = await db`
    with people as (
      select p.id,p.user_id,p.name,p.status,p.created_at,u.disabled_at,
        coalesce(a.role,p.role) as role,
        case when a.id is not null then a.org_unit_id
          when exists(select 1 from employee_assignments old where old.profile_id=p.id and old.deleted_at is null and old.effective_from<=now()) then null
          else p.org_unit_id end as unit_id,
        coalesce(a.overlaps,0) as overlaps
      from profiles p left join users u on u.id=p.user_id
      left join lateral (
        select e.*,count(*) over() as overlaps from employee_assignments e
        where e.profile_id=p.id and e.deleted_at is null and e.effective_from<=now()
          and (e.effective_to is null or e.effective_to>now()) order by e.effective_from desc limit 1
      ) a on true
      where p.deleted_at is null and p.created_at<${end}
    )
    select p.id,p.name,p.role,p.unit_id,p.status,p.disabled_at,p.overlaps,
      count(s.id) filter(where s.created_at>=${start})::int as sign_ins,
      array_agg(distinct s.app order by s.app) filter(where s.created_at>=${start}) as apps,
      min(s.created_at) filter(where s.created_at>=${start}) as first_sign_in,
      max(greatest(case when s.created_at>=${start} then s.created_at end,
        case when s.last_seen_at>=${start} and s.last_seen_at<${end} then s.last_seen_at end)) as last_activity,
      coalesce(bool_or(s.last_seen_at>=${end}),false) as activity_not_retained
    from people p left join sessions s on s.user_id=p.user_id and s.created_at<${end}
      and (${p.app || null}::text is null or s.app=${p.app || null})
    where (${selected === null} or p.unit_id in ${db(selected?.length ? selected : [null])})
      and (${p.role || null}::text is null or p.role=${p.role || null})
    group by p.id,p.name,p.role,p.unit_id,p.status,p.disabled_at,p.overlaps
    having count(s.id) filter(where s.created_at>=${start})>0
      or (p.role='sales' and p.status='active' and p.disabled_at is null)
    order by lower(p.name),p.id limit 5001`;
  if (rows.length > 5000)
    throw invalid("Too many people. Choose a smaller branch or a role.");
  if (rows.some((r) => Number(r.overlaps) > 1))
    throw invalid(
      "An employee has overlapping branch assignments. Check People before viewing this report.",
    );
  const names = new Map(units.map((u) => [u.id, u.name]));
  const people = rows.map((r) => ({
    profileId: r.id,
    name: r.name,
    role: r.role,
    orgUnitId: r.unit_id,
    branch: names.get(r.unit_id) ?? "Unassigned",
    apps: r.apps ?? [],
    signIns: Number(r.sign_ins),
    firstSignInAt: r.first_sign_in ? +new Date(r.first_sign_in) : null,
    lastActivityAt: r.activity_not_retained
      ? null
      : r.last_activity
        ? +new Date(r.last_activity)
        : null,
    activityNotRetained: r.activity_not_retained,
  }));
  return {
    date,
    app: p.app || null,
    role: p.role || null,
    orgUnitId: p.orgUnitId || null,
    units: units.map((u) => ({ id: u.id, name: u.name })),
    signedIn: people.filter((r) => r.signIns > 0),
    didNotSignIn: people.filter((r) => r.signIns === 0),
  };
}
