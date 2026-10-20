import { tx } from "@sunpride/db/client";
import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { recordChange } from "../../core/sync.js";
import { writeAudit } from "../org/audit.js";
import { text } from "../orders/validation.js";

/** Interim national Trade Marketing / Finance boundary until partner grant seams land. @param {any} c @param {string} [capability] */
export async function office(c, capability = "report.read") {
  await requireCapability(c, capability);
  await requireNationalScope(c, [
    "admin",
    "operations",
    "manager",
    "approver",
    "analyst",
    "viewer",
  ]);
}
/** F-501: all commands reauthorize before replay, serialize request keys, and commit audit atomically.
 * @param {any} ctx @param {string} action @param {any} b @param {(c:any)=>Promise<void>} authorize @param {(c:any)=>Promise<any>} work */
export async function command(ctx, action, b, authorize, work) {
  const key = text(b.idempotencyKey, "Request key", 160);
  const hash = sha256Hex(canonicalJson({ action, b }));
  const result = await tx(ctx.db, async (db) => {
    const actor = ctx.actor ? await actorFor(db, ctx.actor.userId) : null;
    if (!actor)
      throw new ApiError("forbidden", 403, "Your access is no longer active");
    const c = { ...ctx, db, actor };
    await authorize(c);
    await db`select pg_advisory_xact_lock(hashtextextended(${actor.subject + ":tpm:" + key},0))`;
    const [old] =
      await db`select * from tpm_commands where actor_subject=${actor.subject} and request_key=${key}`;
    if (old) {
      if (old.payload_hash !== hash)
        throw new ApiError(
          "idempotency_conflict",
          409,
          "Request key was reused for different content",
        );
      return old.response;
    }
    const response = await work(c);
    await db`insert into tpm_commands(actor_subject,request_key,payload_hash,response) values(${actor.subject},${key},${hash},${response})`;
    return response;
  });
  await ctx.publish("tpm");
  return result;
}
/** @param {any} c @param {string} action @param {string} id @param {any} [details] */
export async function changed(c, action, id, details = {}) {
  await writeAudit(c.db, {
    actor: c.actor,
    subject: c.actor.subject,
    action: `tpm.${action}`,
    entityType: "tpm",
    entityId: id,
    details: canonicalJson(details),
    at: c.now,
  });
  await recordChange(c.db, {
    entity: "tpm",
    entityId: id,
    scopeKey: "catalog",
  });
}
/** Explicit overflow beats a silently incomplete financial queue. @param {any[]} rows */
export function bounded(rows) {
  if (rows.length > 500)
    throw new ApiError(
      "too_many_rows",
      422,
      "Narrow the period; more than 500 records match",
    );
  return rows;
}
