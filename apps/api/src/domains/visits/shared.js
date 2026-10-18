import { requireCapability } from "../../core/capabilities.js";
import { forbidden, invalid } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import { isUuid } from "../../core/util.js";
import { outletOwnerUnit } from "../org/scope.js";

export const ORGANIZATION = "sunpride";
export const DAY = 86400000;
export const OPEN = ["arrived", "checked-in", "in-progress"];
export const INTENTS = [
  "sell",
  "collect",
  "merchandise",
  "audit",
  "deliver",
  "promotion",
  "complaint",
  "follow-up",
];
export const PHOTO_TYPES = [
  { code: "storefront", label: "Store front" },
  { code: "shelf_display", label: "Shelf and display" },
  { code: "price_tag", label: "Price tags" },
  { code: "promotion", label: "Promotion material" },
  { code: "other", label: "Other" },
];
/** @param {string} code @returns {never} */
export function reject(code = "invalid_request") {
  throw new OpRejected(code);
}
/** @param {unknown} value @returns {string} */
export function uuid(value) {
  if (!isUuid(value)) throw invalid("Invalid identifier");
  return value;
}
/** @param {unknown} value @param {number} [max] @returns {string} */
export function text(value, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw invalid("Invalid text");
  return value.trim();
}
/** @param {number|Date|string} value */
export const ms = (value) => new Date(value).getTime();
/** @param {number} time */
export const manilaDate = (time) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 10);
/** @param {unknown} value @returns {string} */
export function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw invalid("Invalid Manila date");
  return value;
}
/** @param {string} day */
export const dayClose = (day) => Date.parse(`${day}T14:00:00Z`);
/** @param {any} time @param {number} now */
export function validTime(time, now) {
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    time > now + DAY ||
    now - time > 8 * DAY
  )
    reject();
}
/** @param {any} db @param {string} profileId @param {number} at */
export async function employeeAt(db, profileId, at) {
  const rows =
    await db`select e.*, p.status, p.user_id from employee_assignments e join profiles p on p.id=e.profile_id
    where e.profile_id=${profileId} and e.deleted_at is null and p.deleted_at is null and p.status='active'
    and e.effective_from<=${new Date(at)} and (e.effective_to is null or e.effective_to>${new Date(at)})`;
  if (rows.length !== 1 || !rows[0].org_unit_id)
    throw forbidden("Person has no current assignment", "out_of_scope");
  return rows[0];
}
/** Current owner is authoritative even when reading historical facts. @param {any} ctx @param {string} outletId @param {string} capability */
export async function accessOutlet(ctx, outletId, capability) {
  const [outlet] =
    await ctx.db`select * from outlets where id=${uuid(outletId)} and organization_id=${ORGANIZATION} and deleted_at is null`;
  const owner = outlet && (await outletOwnerUnit(ctx.db, outletId, Date.now()));
  if (!outlet || !owner)
    throw forbidden("Store is outside your scope", "out_of_scope");
  await requireCapability(ctx, capability, owner);
  return { outlet, owner };
}
/** @param {any} ctx @param {any} visit @param {string} [capability] @param {boolean} [own] */
export async function accessVisit(
  ctx,
  visit,
  capability = "visit.read",
  own = false,
) {
  if (!visit || visit.organization_id !== ORGANIZATION || visit.deleted_at)
    throw forbidden("Visit unavailable", "out_of_scope");
  const actor = await requireCapability(ctx, capability, visit.org_unit_id);
  if (
    (own || actor.role === "sales") &&
    visit.assignee_profile_id !== actor.profileId
  )
    throw forbidden("Not your visit", "out_of_scope");
  const person = await employeeAt(
    ctx.db,
    visit.assignee_profile_id,
    Date.now(),
  );
  await requireCapability(ctx, capability, person.org_unit_id);
  const { outlet, owner } = await accessOutlet(
    ctx,
    visit.outlet_id,
    capability,
  );
  if (person.org_unit_id !== owner || outlet.status !== "active")
    throw forbidden("Visit ownership changed", "out_of_scope");
  return visit;
}
/** @param {any} ctx @param {any} visitId @param {boolean} [allowClosed] */
export async function ownedVisit(ctx, visitId, allowClosed = false) {
  if (!["field-ios", "field-android", "web"].includes(ctx.app))
    reject("unsupported_operation");
  const [visit] =
    await ctx.db`select * from visit_executions where id=${uuid(visitId)} for update`;
  await accessVisit(ctx, visit, "visit.record", true);
  if (!allowClosed && !OPEN.includes(visit.state)) reject("invalid_transition");
  return visit;
}
/** Redacted append-only execution event. @param {any} ctx @param {any} visit @param {string} entityType @param {string} entityId @param {string} kind @param {any} [summary] */
export async function event(
  ctx,
  visit,
  entityType,
  entityId,
  kind,
  summary = {},
) {
  for (const value of Object.values(summary))
    if (
      value != null &&
      (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value))
    )
      throw invalid("Invalid event code");
  const [row] = await ctx.db`insert into execution_events
    (organization_id, org_unit_id, entity_type, entity_id, kind, actor_subject, actor_role, actor_org_unit_id,
     device_id, source, operation_key, correlation_id, occurred_at, server_at, summary_before, summary_after, summary_reason_code, schema_version, policy_version)
    values (${ORGANIZATION}, ${visit.org_unit_id}, ${entityType}, ${entityId}, ${kind}, ${ctx.actor.subject}, ${ctx.actor.role},
      ${ctx.actor.orgUnitId ?? visit.org_unit_id}, ${ctx.device?.id ?? null}, ${ctx.device ? "mobile" : "web"},
      ${ctx.op?.clientOpId ?? null}, ${visit.id}, ${new Date(ctx.payload?.deviceTime ?? ctx.now)}, ${new Date(ctx.now)},
      ${summary.before ?? null}, ${summary.after ?? null}, ${summary.reasonCode ?? null}, 2, 'field-day-2026-10-v3') returning id`;
  return row.id;
}
/** Durable post-commit seam dispatch. Never run analytics inside the business transaction. @param {any} ctx @param {any} visit @param {'visit'|'collection'} [kind] */
export async function changed(ctx, visit, kind = "visit") {
  await ctx.enqueue({
    kind: "visits.refresh",
    key: `${kind}:${new Date(visit.service_date).toISOString().slice(0, 10)}:${visit.org_unit_id}`,
    payload: {
      kind,
      date: new Date(visit.service_date).toISOString().slice(0, 10),
      unitId: visit.org_unit_id,
    },
  });
  await ctx.change("visit", visit.id, visit.org_unit_id);
  ctx.publish("visits");
}
/** @param {any} ctx @param {any} visit */
export async function touchVisit(ctx, visit) {
  const late =
    ctx.now > dayClose(new Date(visit.service_date).toISOString().slice(0, 10));
  await ctx.db`update visit_executions set last_server_time=${new Date(ctx.now)},
    late_sync_at=case when ${late} then coalesce(late_sync_at, ${new Date(ctx.now)}) else late_sync_at end,
    late_review_status=case when ${late} then 'pending_review' else late_review_status end where id=${visit.id}`;
}
/** @param {any} db @param {string} productId */
export async function product(db, productId) {
  const [row] =
    await db`select * from products where id=${uuid(productId)} and active and deleted_at is null
    and (organization_id is null or organization_id=${ORGANIZATION})`;
  if (!row) reject();
  return row;
}
