import { ApiError } from "../../core/errors.js";
import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { writeAudit } from "../org/audit.js";
import { recordChange } from "../../core/sync.js";
import { text } from "../orders/validation.js";

/** @param {unknown} v @param {string} [label] */
export function money(v, label = "Amount") {
  if (
    !Number.isSafeInteger(v) ||
    Number(v) < 0 ||
    Number(v) > 1_000_000_000_000
  )
    throw new ApiError(
      "invalid_request",
      400,
      `${label} must be whole centavos within the supported range`,
    );
  return Number(v);
}
/** @param {unknown} v @param {string} [label] */
export function instant(v, label = "Effective date") {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new ApiError(
      "invalid_request",
      400,
      `${label} must be an ISO instant`,
    );
  return new Date(v);
}
/** @param {any} c @param {string} action @param {string} id @param {string} [note] */
export async function audit(c, action, id, note = "Modern trade updated") {
  await writeAudit(c.db, {
    subject: c.user?.id ?? c.actor?.userId,
    action: `mt.${action}`,
    entityType: "modern_trade",
    entityId: id,
    details: note,
  });
}
/** Reauthenticate and authorize BEFORE replay in the same transaction.
 * @param {any} c @param {string} action @param {any} b
 * @param {(c:any)=>Promise<any>} authorize @param {(c:any)=>Promise<any>} work
 * @param {boolean} [portal] */
export async function command(c, action, b, authorize, work, portal = false) {
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new ApiError("invalid_request", 400, "A command object is required");
  if (!c.user)
    throw new ApiError("unauthenticated", 401, "Sign in to continue");
  const key = text(
    b.idempotencyKey ?? c.req.headers.get("idempotency-key"),
    "Request key",
    160,
  );
  const hash = sha256Hex(canonicalJson({ action, b }));
  const result = await tx(c.db, async (db) => {
    const actor = portal ? null : await actorFor(db, c.user.id);
    if (!portal && !actor)
      throw new ApiError("forbidden", 403, "Your access is no longer active");
    const cc = { ...c, db, actor, now: Date.now() };
    await db`select pg_advisory_xact_lock(hashtextextended('mt-workflow',0))`;
    await authorize(cc);
    const [old] =
      await db`select * from mt_commands where user_id=${c.user.id} and request_key=${key}`;
    if (old) {
      if (old.payload_hash !== hash)
        throw new ApiError(
          "idempotency_conflict",
          409,
          "Request key was reused for different content",
        );
      return old.response;
    }
    const response = await work(cc);
    await db`insert into mt_commands(user_id,request_key,payload_hash,response) values(${c.user.id},${key},${hash},${response})`;
    await recordChange(db, {
      entity: "mt.reference",
      entityId: response.id ?? c.user.id,
      scopeKey: "global",
    });
    return response;
  }).catch((e) => {
    if (["23505", "23P01"].includes(e?.errno ?? e?.code))
      throw new ApiError(
        "conflict",
        409,
        "A duplicate or overlapping record already exists",
      );
    throw e;
  });
  await c.publish("mt");
  return result;
}
