import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, isUuid, sha256Hex } from "../../core/util.js";
import { recordChange } from "../../core/sync.js";
import { partnerContext } from "./boundary.js";

/** @param {string} message @param {string} [code] @param {number} [status] @returns {never} */
export function fail(message, code = "invalid_request", status = 422) {
  throw new ApiError(code, status, message);
}
/** @param {any} v @param {number} [max] */
export function text(v, max = 160) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail("Enter the required text");
  return v.trim();
}
/** @param {any} v */
export function uuid(v) {
  if (!isUuid(v)) fail("Choose a valid record");
  return v;
}
/** @param {any} v @param {number} [min] @param {number} [max] */
export function integer(v, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    fail("Enter a supported whole number");
  return Number(v);
}
/** @param {any} v */
export function date(v) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    fail("Choose a real date");
  return v;
}
/** @param {any} v */
export const day = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
/** @param {number} [n] */
export const today = (n = Date.now()) =>
  new Date(n + 28800000).toISOString().slice(0, 10);
/** @param {any} v */
export const digest = (v) => sha256Hex(canonicalJson(v));
/** @param {any} v */
export const wire = (v) =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)),
  );
/** @param {any[]} rows @param {number} max */
export function bound(rows, max) {
  if (rows.length > max)
    fail(
      "Narrow the period; the supported evidence bound was exceeded",
      "evidence_overflow",
    );
  return rows;
}
/** @param {any} c @param {string} id @param {string} [grant] @param {boolean} [write] */
export async function authorize(c, id, grant = "portal", write = false) {
  uuid(id);
  if (!c.actor) fail("Sign in to continue", "unauthenticated", 401);
  const m = await partnerContext(c.db, c.actor);
  const [p] =
    await c.db`select * from distributors where id=${id} and partner_kind='agency' and effective_from<=now() and (effective_to is null or effective_to>now())`;
  if (!p) fail("Agency unavailable", "out_of_scope", 403);
  if (m) {
    if (
      write ||
      m.distributor_id !== id ||
      m.partner_kind !== "agency" ||
      !m.grants.includes(grant)
    )
      fail(
        "Your agency access does not allow this action",
        "out_of_scope",
        403,
      );
  } else
    await requireCapability(
      c,
      write ? "integration.manage" : "integration.read",
      p.org_unit_id,
    );
  return p;
}
/** @param {any} c @param {(c:any)=>Promise<any>} fn */
export async function read(c, fn) {
  return tx(c.db, async (db) => {
    const actor = c.actor ? await actorFor(db, c.actor.userId) : null;
    return wire(await fn({ ...c, db, actor, now: Date.now() }));
  });
}
/** @param {any} c @param {string} action @param {(c:any,p:any,b:any)=>Promise<any>} fn @param {{grant?:string,office?:boolean,replay?:(c:any,p:any,response:any)=>Promise<any>}} [options] */
export async function command(
  c,
  action,
  fn,
  { grant = "portal", office = true, replay } = {},
) {
  const b = c.body ?? {},
    id = uuid(b.partnerId),
    key = text(b.requestKey),
    hash = digest({ action, b });
  const result = await tx(c.db, async (db) => {
    const actor = c.actor ? await actorFor(db, c.actor.userId) : null;
    const cc = { ...c, db, actor, now: Date.now() };
    await db`select id from distributors where id=${id} for update`;
    const p = await authorize(cc, id, grant, office);
    const [old] =
      await db`select * from partner_commands where distributor_id=${id} and actor_id=${actor?.profileId} and request_key=${key}`;
    if (old) {
      if (old.payload_hash !== hash)
        fail(
          "Request key belongs to different content",
          "idempotency_conflict",
          409,
        );
      if (replay) await replay(cc, p, old.response);
      return { ...old.response, duplicate: true };
    }
    const response = wire(await fn(cc, p, b));
    await db`insert into partner_commands(distributor_id,actor_id,request_key,payload_hash,response) values(${id},${actor?.profileId},${key},${hash},${response})`;
    await db`insert into partner_events(distributor_id,actor_id,action,details) values(${id},${actor?.profileId},${action},${{ id: response.id ?? null }})`;
    await recordChange(db, {
      entity: "partner",
      entityId: id,
      scopeKey: `partner:${id}`,
    });
    return response;
  });
  await c.publish(`partner:${id}`);
  return result;
}
