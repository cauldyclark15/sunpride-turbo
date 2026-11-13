import { ApiError } from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { hooks } from "../../core/hooks.js";

export const DAY = 86400000;
export const ORG = "sunpride";
/** @param {string} message @param {string} [code] */
export function fail(message, code = "invalid_plan") {
  throw new ApiError(code, 422, message);
}
/** @param {number} ms */
export const manilaDate = (ms) =>
  new Date(ms + 28800000).toISOString().slice(0, 10);
/** @param {string} date */
export function localDate(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  )
    fail("Invalid Manila date");
  return ms - 28800000;
}
/** @param {string} month */
export function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail("Invalid Manila month");
  const from = localDate(`${month}-01`);
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const to = next.getTime() - 28800000;
  return { from, to };
}
/** @param {string} month */
export function monthDates(month) {
  const { from, to } = monthBounds(month);
  return Array.from({ length: (to - from) / DAY }, (_, i) =>
    manilaDate(from + i * DAY),
  );
}
/** @param {unknown} value @param {string} label */
export function required(value, label) {
  // EDGE-023: a too-long reason says so; "required" only when nothing was typed.
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required`);
  if (/** @type {string} */ (value).trim().length > 500)
    fail(`${label} is too long (up to 500 characters)`);
  return /** @type {string} */ (value).trim();
}
/** @param {unknown} id */
export function uuid(id) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    fail("Invalid identifier");
  return /** @type {string} */ (id);
}
/** @param {any[]} rows @param {string} [label] @param {number} [max] */
export function bounded(rows, label = "Rows", max = 500) {
  if (rows.length > max) fail(`${label} exceeds ${max} rows`, "too_many_rows");
  return rows;
}
/** A month of daily calls (26 selling days x 25+ stops, plus activities) is
 * well past 500 rows; plans are bounded by this per-table ceiling instead. */
export const PLAN_ROW_LIMIT = 5000;
/** @param {any} value */
const dateText = (value) =>
  typeof value === "string"
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
/** @param {any} value @returns {any} */
export function dto(value) {
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(dto);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [
          k === "id"
            ? "_id"
            : k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
          k.endsWith("_date")
            ? dateText(v)
            : k.endsWith("_dates") && Array.isArray(v)
              ? v.map(dateText)
              : dto(v),
        ]),
    );
  return value;
}
/** @param {any} row */
export function civil(row) {
  const result = dto(row);
  if (row.service_date)
    result.serviceDate =
      typeof row.service_date === "string"
        ? row.service_date.slice(0, 10)
        : row.service_date.toISOString().slice(0, 10);
  return result;
}
/** @param {any} db @param {string} profileId @param {number} at @param {string} [message] */
export async function employeeAt(
  db,
  profileId,
  at,
  message = "Assignee has no effective employee assignment with unit",
) {
  const [a] =
    await db`select a.* from employee_assignments a join profiles p on p.id=a.profile_id where a.profile_id=${uuid(profileId)} and p.status='active' and p.deleted_at is null and a.deleted_at is null and a.effective_from<=${new Date(at)} and (a.effective_to is null or a.effective_to>${new Date(at)})`;
  if (!a?.org_unit_id) fail(message);
  return a;
}
/** Current scope is checked even for historical and future reads. @param {any} ctx @param {any} p @param {string} [cap] */
export async function access(ctx, p, cap = "mcp.read") {
  const actor = await requireCapability(ctx, cap, p.org_unit_id);
  if (actor.role === "sales" && actor.profileId !== p.assignee_profile_id)
    throw new ApiError("out_of_scope", 403, "Sales may access only own plan");
  const current = await employeeAt(ctx.db, p.assignee_profile_id, ctx.now);
  await requireCapability(ctx, cap, current.org_unit_id);
  return actor;
}
/** @param {any} db @param {string} id @param {boolean} [lock] */
export async function loadPlan(db, id, lock = false) {
  const rows = lock
    ? await db`select * from coverage_plans where id=${uuid(id)} and deleted_at is null for update`
    : await db`select * from coverage_plans where id=${uuid(id)} and deleted_at is null`;
  if (!rows[0]) throw new ApiError("not_found", 404, "Plan not found");
  return rows[0];
}
/** @param {any} db @param {string} id */
export async function planRows(db, id) {
  const n = PLAN_ROW_LIMIT + 1;
  const outlets = bounded(
    await db`select * from coverage_plan_outlets where plan_id=${id} order by outlet_id limit ${n}`,
    "Plan outlets",
    PLAN_ROW_LIMIT,
  );
  const slots = bounded(
    await db`select * from coverage_plan_slots where plan_id=${id} and deleted_at is null order by service_date,sequence,slot_key limit ${n}`,
    "Plan slots",
    PLAN_ROW_LIMIT,
  );
  const assignments = bounded(
    await db`select * from coverage_assignments where plan_id=${id} order by effective_from limit ${n}`,
    "Plan assignments",
    PLAN_ROW_LIMIT,
  );
  return { outlets, slots, assignments };
}
/** @param {any} ctx @param {string} outletId @param {number} at @param {string} [cap] */
export async function outletAt(ctx, outletId, at, cap = "mcp.read") {
  const db = ctx.db;
  const [o] =
    await db`select * from outlets where id=${uuid(outletId)} and deleted_at is null`;
  if (!o) fail("Outlet not found");
  const [a] =
    await db`select * from outlet_assignments where outlet_id=${outletId} and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  const [owner] = a
    ? await db`select * from territory_ownerships where territory_id=${a.territory_id} and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`
    : [];
  const unit = owner?.org_unit_id ?? (!a ? o.custodian_org_unit_id : null);
  if (!unit) fail("Territory has no effective owner");
  await requireCapability(ctx, cap, unit);
  return { outlet: o, assignment: a, owner, orgUnitId: unit };
}
/** @param {any} ctx @param {any} p @param {string} action @param {any} before @param {any} after @param {string|null} [reason] @param {string|null} [signatureRef] */
export async function audit(ctx, p, action, before, after, reason = null, signatureRef = null) {
  await ctx.db`insert into coverage_audit_events (plan_id,assignee_profile_id,org_unit_id,local_month,actor_subject,action,reason,affected_entity,before,after,plan_version,approval_signature_ref,created_at)
  values (${p.id},${p.assignee_profile_id},${p.org_unit_id},${p.local_month},${ctx.actor?.subject ?? "scheduler"},${action},${reason},'coveragePlan',${before},${after},${p.version},${signatureRef},${new Date(ctx.now)})`;
}
/** @param {any} ctx */
export async function visiblePeople(ctx) {
  const actor = await requireCapability(ctx, "mcp.read");
  const db = ctx.db;
  const units = ["super_admin", "analyst"].includes(actor.role)
    ? null
    : await hooks.scopeUnitIds(db, actor);
  if (units && !units.length) return [];
  const rows =
    await db`select p.*, a.org_unit_id as current_unit_id, a.supervisor_id,(p.role='sales' or (pos.active and pos.category<>'support')) as needs_mcp from profiles p join employee_assignments a on a.profile_id=p.id left join positions pos on pos.id=a.position_id
  where p.status='active' and p.deleted_at is null and a.deleted_at is null and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
  and (p.role='sales' or (pos.active and pos.category<>'support') or p.id=${actor.profileId}) order by p.name,p.id`;
  return bounded(
    rows.filter(
      /** @param {any} p */ (p) =>
        (roleHas(p.role, "mcp.plan") || p.id === actor.profileId) &&
        (actor.role !== "sales" || p.id === actor.profileId) &&
        (!units || units.includes(p.current_unit_id)),
    ),
    "Scoped people",
  );
}
/** @param {any[]} rows @param {any} opts */
export function page(rows, opts = { numItems: 20, cursor: null }) {
  const n = opts.numItems ?? 20,
    offset = opts.cursor == null ? 0 : Number(opts.cursor);
  if (
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (opts.cursor != null && String(offset) !== opts.cursor)
  )
    fail("Invalid page cursor or size");
  return {
    page: rows.slice(offset, offset + n),
    isDone: offset + n >= rows.length,
    continueCursor: String(offset + n),
  };
}
