import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { scopeFilterForActor, outletOwnerUnit } from "../org/scope.js";

import { fail, uuid, text, ms, hash, noon } from "./validation.js";
export * from "./validation.js";

/** @param {any} c @param {string} cap @param {string|null} unit */
export async function gate(c, cap, unit) {
  const actor = await requireCapability(c, cap);
  if (!unit && !["super_admin", "analyst"].includes(actor.role))
    fail("This record has no organizational scope", 403, "no_scope");
  await requireCapability(c, cap, unit);
  return actor;
}
/** @param {any} c @param {string} id @param {string} [cap] */
export async function person(c, id, cap = "report.read") {
  uuid(id);
  const [p] =
    await c.db`select p.*, coalesce(a.org_unit_id,p.org_unit_id) current_unit, coalesce(a.position_id,p.position_id) current_position, coalesce(a.role,p.role) current_role, pos.label position_label, pos.code position_code, u.organization_id from profiles p left join lateral (select * from employee_assignments a where a.profile_id=p.id and a.deleted_at is null and a.effective_from<=${new Date(c.now)} and (a.effective_to is null or a.effective_to>${new Date(c.now)}) order by effective_from desc limit 1) a on true left join positions pos on pos.id=coalesce(a.position_id,p.position_id) left join org_units u on u.id=coalesce(a.org_unit_id,p.org_unit_id) where p.id=${id} and p.deleted_at is null`;
  if (!p) fail("Person not found", 404, "not_found");
  await gate(c, cap, p.current_unit);
  if (c.actor.role === "sales" && id !== c.actor.profileId)
    fail("You can read only your own reports", 403, "forbidden");
  return {
    ...p,
    org_unit_id: p.current_unit,
    position_id: p.current_position,
    role: p.current_role,
  };
}
/** @param {any} c @param {string} id @param {string} [cap] */
export async function outlet(c, id, cap = "outlet.read") {
  uuid(id);
  const [o] =
    await c.db`select * from outlets where id=${id} and deleted_at is null`;
  if (!o) fail("Account not found", 404, "not_found");
  const unit = await outletOwnerUnit(c.db, id, c.now);
  await gate(c, cap, unit);
  return o;
}
/** Complete enumeration after SQL role/status filters. No profile-prefix truncation. @param {any} c @param {any} [f] @param {boolean} [allRoles] */
export async function roster(c, f = {}, allRoles = false) {
  await requireCapability(c, "people.read");
  await requireCapability(c, "visit.read");
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  if (unitIds !== null && !unitIds.length)
    fail("Your access has no organizational scope", 403, "no_scope");
  if (f.orgUnitId) {
    uuid(f.orgUnitId);
    await gate(c, "people.read", f.orgUnitId);
  }
  const rows =
    await c.db`select p.*, coalesce(a.org_unit_id,p.org_unit_id) current_unit, coalesce(a.position_id,p.position_id) current_position, a.supervisor_id, pos.label position_label, pos.code position_code, u.organization_id
 from profiles p
 left join lateral (select * from employee_assignments a where a.profile_id=p.id and a.deleted_at is null and a.effective_from<=${new Date(c.now)} and (a.effective_to is null or a.effective_to>${new Date(c.now)}) order by a.effective_from desc limit 1) a on true
 left join positions pos on pos.id=coalesce(a.position_id,p.position_id)
 left join org_units u on u.id=coalesce(a.org_unit_id,p.org_unit_id)
 where p.status='active' and p.deleted_at is null and (${allRoles} or coalesce(a.role,p.role)='sales') order by p.name,p.id`;
  const result = [];
  for (const p of rows) {
    if (unitIds !== null && !unitIds.includes(p.current_unit)) continue;
    if (f.orgUnitId) {
      const narrowed = { ...c.actor, orgUnitId: f.orgUnitId, role: "viewer" };
      const scope = await scopeFilterForActor(c.db, narrowed);
      if (scope.unitIds !== null && !scope.unitIds.includes(p.current_unit))
        continue;
    }
    const channel = p.channel_scope || p.position_label || "Unassigned";
    const direct = p.supervisor_id === c.actor.profileId;
    if ((f.channel && f.channel !== channel) || (f.directOnly && !direct))
      continue;
    result.push({
      ...p,
      org_unit_id: p.current_unit,
      position_id: p.current_position,
      channel,
      direct,
    });
  }
  if (result.length > 200)
    fail("Narrow the team to an area or channel", 422, "report_limit");
  return result;
}
/** @param {any} c @param {any} p @param {string} d */
export async function standard(c, p, d) {
  const rows =
    await c.db`select * from position_standards where position_id=${p.position_id} and deleted_at is null and effective_from<=${noon(d)} and (effective_to is null or effective_to>${noon(d)})`;
  if (rows.length > 1) fail("Overlapping position standards", 409);
  return rows[0] ?? null;
}
/** HTTP commands authorize inside the transaction before even looking up a replay. @param {any} c @param {any} platform @param {string} name @param {string} topic @param {(c:any,b:any,replay?:any)=>Promise<any>} authorize @param {(c:any,b:any)=>Promise<any>} run */
export async function command(c, platform, name, topic, authorize, run) {
  const b = c.body;
  if (!b || typeof b !== "object") fail("A command body is required", 400);
  const key = text(
    b.idempotencyKey ?? c.req.headers.get("idempotency-key"),
    160,
  );
  if (!key) fail("A request key is required", 400);
  const digest = hash(b);
  const result = await tx(c.db, async (/** @type {any} */ db) => {
    const tc = { ...c, db };
    await authorize(tc, b);
    await db`select pg_advisory_xact_lock(hashtextextended(${c.actor.profileId + name + key},0))`;
    const [old] =
      await db`select * from field_report_commands where actor_id=${c.actor.profileId} and command=${name} and request_key=${key}`;
    if (old) {
      if (old.payload_hash !== digest)
        fail(
          "This request key was already used for different content",
          409,
          "idempotency_conflict",
        );
      await authorize(tc, b, old.result.value);
      return old.result.value;
    }
    const value = await run(tc, b);
    await db`insert into field_report_audit(actor_id,command,entity_id,details) values(${c.actor.profileId},${name},${typeof value === "string" ? value : (b.sessionId ?? b.sheetId ?? b.formId ?? b.outletId ?? b.profileId ?? b.activityId ?? null)},${{ requestHash: digest }})`;
    await db`insert into field_report_commands(actor_id,command,request_key,payload_hash,result) values(${c.actor.profileId},${name},${key},${digest},${{ value }})`;
    return value;
  });
  await platform.publish(topic);
  return result;
}
export { requireCapability, roleHas };
