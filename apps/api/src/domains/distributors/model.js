import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex, isUuid } from "../../core/util.js";
import { recordChange } from "../../core/sync.js";
import { scopeFilterForActor } from "../org/scope.js";

/** @typedef {Record<string,any>} Row */
/** @param {string} message @param {string} [code] @param {number} [status] @returns {never} */
export function fail(message, code = "invalid_request", status = 422) {
  throw new ApiError(code, status, message);
}
/** @param {any} v @param {string} [label] @param {number} [max] */
export function text(v, label = "Value", max = 160) {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    fail(`${label} is required (up to ${max} characters)`);
  return v.trim();
}
/** @param {any} v @param {string} [label] */
export function uuid(v, label = "Record") {
  if (typeof v !== "string" || !isUuid(v)) fail(`${label} is invalid`);
  return v;
}
/** @param {any} v @param {number} [min] @param {number} [max] */
export function integer(v, min = 0, max = 1_000_000_000_000) {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    fail("Enter a whole number in the supported range");
  return /** @type {number} */ (v);
}
/** @param {any} v */
export function date(v) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    fail("Enter a real date as YYYY-MM-DD");
  return v;
}
/** @param {number} [now] */
export const today = (now = Date.now()) =>
  new Date(now + 28_800_000).toISOString().slice(0, 10);
/** @param {string} d @param {number} n */
export const dayAdd = (d, n) =>
  new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
/** @param {any} value @param {number} [max] @returns {any[]} */
export function list(value, max = 500) {
  if (!Array.isArray(value) || value.length > max)
    fail(`Use an array with at most ${max} rows`);
  return value;
}
/** @param {any} v */
export const digest = (v) => sha256Hex(canonicalJson(v));
/** @param {any} v @returns {any} */
export function wire(v) {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)),
  );
}
export const PARTNER_GRANTS = Object.freeze([
  "read",
  "order",
  "stock",
  "secondary",
  "claim",
  "finance",
  "documents",
  "dsr",
  "settlement",
]);
/** Staff access is capability AND current supervising unit, never global merely because someone is a manager.
 * Partner role has zero core capabilities, so internal queries/exports/sync fail closed.
 * @param {any} c @param {string} id @param {string} [grant] @param {boolean} [office]
 */
export async function authorize(c, id, grant = "read", office = false) {
  uuid(id, "Distributor");
  if (!c.actor) fail("Sign in to continue", "unauthenticated", 401);
  const [d] =
    await c.db`select * from distributors where id=${id} and effective_from <= now() and (effective_to is null or effective_to > now())`;
  if (!d) fail("Distributor unavailable", "out_of_scope", 403);
  if (c.actor.role === "distributor") {
    if (office) fail("Sunpride permission required", "forbidden", 403);
    const [member] =
      await c.db`select u.* from distributor_users u join profiles p on p.id=u.profile_id where u.distributor_id=${id} and u.profile_id=${c.actor.profileId} and u.effective_from<=now() and (u.effective_to is null or u.effective_to>now()) and p.user_id=${c.actor.userId} and p.status='active' and p.role='distributor' and p.deleted_at is null and p.org_unit_id=${d.device_org_unit_id}`;
    if (c.device?.id) {
      const [device] =
        await c.db`select id from registered_devices where id=${c.device.id} and profile_id=${c.actor.profileId} and status='active' and bound_subject=${c.actor.subject} and org_unit_id=${d.device_org_unit_id}`;
      if (!device) fail("Partner device access changed", "out_of_scope", 403);
    }
    if (
      !member ||
      !d.device_org_unit_id ||
      c.actor.orgUnitId !== d.device_org_unit_id ||
      !member.grants.includes(grant) ||
      ["suspended", "rejected"].includes(d.status)
    )
      fail(
        "Your distributor access does not permit this action",
        "out_of_scope",
        403,
      );
    return d;
  }
  await requireCapability(
    c,
    office ? "integration.manage" : "integration.read",
  );
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  if (unitIds !== null && !unitIds.includes(d.org_unit_id))
    fail("Distributor outside your area", "out_of_scope", 403);
  return d;
}
/** @param {any} c @param {string} id */
export async function policy(c, id) {
  const [p] =
    await c.db`select * from distributor_policies where distributor_id=${id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  if (!p) fail("Distributor policy needs setup", "needs_setup");
  return p.settings;
}
/** @param {any} c @param {string} id */
export async function master(c, id) {
  const [m] =
    await c.db`select * from distributor_master_versions where distributor_id=${id} and effective_from<=now() and (effective_to is null or effective_to>now()) order by version desc limit 1`;
  if (!m) fail("SAP master snapshot needs synchronization", "needs_setup");
  return m;
}
/** All writes reauthenticate and lock authorization BEFORE replay. One scoped receipt per intent.
 * @param {any} c @param {string} action @param {string} grant @param {(c:any,d:Row,b:Row)=>Promise<any>} fn @param {boolean} [office]
 */
export async function command(c, action, grant, fn, office = false) {
  const b = c.body;
  if (!b || typeof b !== "object" || Array.isArray(b))
    fail("A command object is required");
  const id = uuid(b.distributorId, "Distributor");
  const key = text(
    b.requestKey ?? c.req.headers.get("idempotency-key"),
    "Request key",
  );
  const hash = digest({ action, b });
  const result = await tx(c.db, async (db) => {
    const actor = c.actor ? await actorFor(db, c.actor.userId) : null;
    const cc = { ...c, db, actor, now: Date.now() };
    // Lock the partner as well as membership changes, so same-partner order/AR checks serialize.
    await db`select id from distributors where id=${id} for update`;
    const d = await authorize(cc, id, grant, office);
    const [old] =
      await db`select * from distributor_commands where distributor_id=${id} and actor_id=${actor?.profileId} and request_key=${key}`;
    if (old) {
      if (old.payload_hash !== hash)
        fail(
          "Request key already used for different content",
          "idempotency_conflict",
          409,
        );
      return { ...old.response, duplicate: true };
    }
    const response = wire(await fn(cc, d, b));
    await db`insert into distributor_commands(distributor_id,actor_id,request_key,payload_hash,response) values(${id},${actor?.profileId},${key},${hash},${response})`;
    await db`insert into distributor_events(distributor_id,actor_id,action,entity_id) values(${id},${actor?.profileId},${action},${response?.id ?? null})`;
    await recordChange(db, {
      entity: "distributor",
      entityId: id,
      scopeKey: `partner:${id}`,
    });
    return response;
  });
  await c.publish(`distributor:${id}`);
  return result;
}
/** Read back the current identity inside a consistent snapshot. @param {any} c @param {(c:any)=>Promise<any>} fn */
export async function read(c, fn) {
  return tx(c.db, async (db) => {
    const actor = c.actor ? await actorFor(db, c.actor.userId) : null;
    return wire(await fn({ ...c, db, actor }));
  });
}
/** @param {any} c @param {string} id @param {string} productId */
export async function product(c, id, productId) {
  const m = await master(c, id);
  const entry = list(m.payload.products, 1000).find(
    (p) => p.productId === uuid(productId, "Product"),
  );
  const [p] =
    await c.db`select id,code,name,uom,quantity_scale from products where id=${productId} and active and deleted_at is null`;
  if (!entry || !p)
    fail("Product is not in this distributor's catalog", "out_of_scope", 403);
  return { ...p, ...entry };
}
/** @param {any} c @param {string} id @param {string} locationId */
export async function location(c, id, locationId) {
  const [l] =
    await c.db`select * from distributor_locations where id=${uuid(locationId)} and distributor_id=${id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  if (!l)
    fail("Location is not assigned to this distributor", "out_of_scope", 403);
  return l;
}
/** Exact shared outlet, never inferred from an accounting-customer code. @param {any} c @param {string} id @param {string} outletId */
export async function outlet(c, id, outletId) {
  const [o] =
    await c.db`select o.id,o.code,o.name from distributor_outlets g join outlets o on o.id=g.outlet_id where g.distributor_id=${id} and g.outlet_id=${uuid(outletId)} and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now()) and o.deleted_at is null`;
  if (!o)
    fail("Outlet is not assigned to this distributor", "out_of_scope", 403);
  return o;
}
