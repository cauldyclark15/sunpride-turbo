import { ApiError, forbidden, invalid } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { isUuid } from "../../core/util.js";
import { scopeFilterForActor, outletOwnerUnit } from "../org/scope.js";

export const ORGANIZATION = "sunpride";
export const DAY_MS = 86_400_000;
export const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
/** @param {number} now */
export const manilaDate = (now) =>
  new Date(now + 28_800_000).toISOString().slice(0, 10);
/** @param {string} date */
export const midnight = (date) => Date.parse(`${date}T00:00:00+08:00`);
/** @param {string} date */
export const closeAt = (date) => midnight(date) + 22 * 3_600_000;
/** @param {any} value */
export const ms = (value) => (value == null ? null : new Date(value).getTime());
/** @param {any} value */
export const dateOf = (value) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
/** @param {any} value */
export function serviceDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw invalid("Choose a valid Manila date");
  return value;
}
/** @param {any} value */
export function uuid(value) {
  if (!isUuid(value) || value !== value.toLowerCase())
    throw invalid("Invalid reference");
  return value;
}
/** @param {string} [message] */
export function rebootstrap(
  message = "The day plan or reference data changed",
) {
  return new ApiError("rebootstrap_required", 409, message, false, {
    action: "rebootstrap",
  });
}
/** @param {any} rows @param {number} cap */
export function bounded(rows, cap) {
  if (rows.length > cap)
    throw new ApiError(
      "projection_too_large",
      422,
      "Narrow the requested data; the supported bound was exceeded",
      false,
      { action: "hold" },
    );
  return rows;
}
/** @param {any} value */
export function safeInt(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new ApiError(
      "projection_overflow",
      422,
      "This value exceeds the phone's supported range",
    );
  return n;
}
/** Current organizational scope AND supervisory relationship. Filters happen before the cap. @param {any} ctx @param {boolean} [directOnly] @param {string} [capability] */
export async function visiblePeople(
  ctx,
  directOnly = false,
  capability = "location.read",
) {
  const actor = await requireCapability(ctx, capability);
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const ids = unitIds?.length ? unitIds : [ZERO_UUID];
  const db = ctx.db;
  const rows = await db`
    with recursive edges as (
      select profile_id, supervisor_id from employee_assignments
      where effective_from <= ${new Date(ctx.now)} and (effective_to is null or effective_to > ${new Date(ctx.now)}) and deleted_at is null
      union
      select m.profile_id, t.supervisor_profile_id from teams t join team_memberships m on m.team_id = t.id
      where t.status = 'active' and t.supervisor_profile_id is not null
        and t.effective_from <= ${new Date(ctx.now)} and (t.effective_to is null or t.effective_to > ${new Date(ctx.now)})
        and m.effective_from <= ${new Date(ctx.now)} and (m.effective_to is null or m.effective_to > ${new Date(ctx.now)})
    ), reports as (
      select ${actor.profileId}::uuid as id, 0 as depth
      union select e.profile_id, r.depth + 1 from reports r join edges e on e.supervisor_id = r.id
      where r.depth < 20
    )
    select p.*, coalesce(a.org_unit_id, p.org_unit_id) as current_unit_id,
      (select name from org_units where id=coalesce(a.org_unit_id,p.org_unit_id)) as current_unit_name,
      coalesce(a.position_id, p.position_id) as current_position_id,
      pos.label as position_label, exists(select 1 from edges where profile_id=p.id and supervisor_id=${actor.profileId}) as direct
    from profiles p
    left join employee_assignments a on a.profile_id = p.id and a.deleted_at is null
      and a.effective_from <= ${new Date(ctx.now)} and (a.effective_to is null or a.effective_to > ${new Date(ctx.now)})
    left join positions pos on pos.id = coalesce(a.position_id,p.position_id)
    where p.status = 'active' and p.deleted_at is null
      and exists(select 1 from org_units u where u.id=coalesce(a.org_unit_id,p.org_unit_id) and u.organization_id=${ORGANIZATION} and u.deleted_at is null)
      and (${!directOnly} or p.id=${actor.profileId} or exists(select 1 from edges where profile_id=p.id and supervisor_id=${actor.profileId}))
      and (${unitIds === null} or coalesce(a.org_unit_id,p.org_unit_id) in ${db(ids)})
      and (${actor.role !== "sales"} or p.id = ${actor.profileId})
      and (${actor.role !== "manager"} or p.id in (select id from reports where depth <= ${directOnly ? 1 : 20}))
    order by p.name,p.id limit 501`;
  return bounded(rows, 500);
}
/** @param {any} ctx @param {string} profileId @param {string} [capability] */
export async function personInScope(
  ctx,
  profileId,
  capability = "location.read",
) {
  const person = (await visiblePeople(ctx, false, capability)).find(
    (/** @type {any} */ p) => p.id === profileId,
  );
  if (!person)
    throw forbidden("This person is outside your team", "out_of_scope");
  return person;
}
/** Require the current stored owner even for a historical snapshot. @param {any} ctx @param {string} outletId */
export async function outletInScope(ctx, outletId) {
  const owner = await outletOwnerUnit(ctx.db, outletId, ctx.now);
  if (!owner)
    throw forbidden("This store has no authorized owner", "out_of_scope");
  await requireCapability(ctx, "outlet.read", owner);
}
/** @param {{latitude:number,longitude:number}} a @param {{latitude:number,longitude:number}} b */
export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.latitude - a.latitude) * rad) / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(((b.longitude - a.longitude) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
