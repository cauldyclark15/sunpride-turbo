import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import {
  ApiError,
  conflict,
  forbidden,
  invalid,
  unauthenticated,
} from "../../core/errors.js";
import { isUuid, sha256Hex, canonicalJson } from "../../core/util.js";
import { loadProfile } from "../../core/hooks.js";

/** F-007/F-024: all lifecycle decisions are persisted and checked before replay. @param {any} db @param {any} device */
export async function requireDeviceIntegrity(db, device) {
  const [control] =
    await db`select id from device_controls where device_id=${device.id} and status='pending' limit 1`;
  if (control)
    throw forbidden(
      "This phone must reconcile its saved work",
      "device_control_pending",
    );
  const assessments =
    await db`select distinct on(source) * from device_integrity_assessments where device_id=${device.id} order by source,observed_at desc,id desc`;
  // F-024 fail closed: missing/expired observations require refresh; bad MDM cannot be superseded by a clean self-report.
  const [exception] =
    await db`select id from device_integrity_exceptions where device_id=${device.id} and effective_from<=now() and effective_to>now() limit 1`;
  if (exception) return;
  if (assessments.some((/** @type {any} */ a) => a.rooted || a.tampered))
    throw forbidden(
      "Device integrity review required",
      "device_integrity_blocked",
    );
  if (
    !assessments.some(
      (/** @type {any} */ a) => new Date(a.expires_at).getTime() > Date.now(),
    )
  )
    throw forbidden(
      "Refresh this phone's integrity assessment",
      "device_integrity_required",
    );
}

/** Native OS signals are useful but explicitly NOT hardware attestation. MDM assessments are separate. @param {any} t @param {any} device @param {any} report */
export async function recordDeviceAssessment(t, device, report) {
  if (report == null) return; // Pre-upgrade clients remain labelled unverified, never claimed attested.
  if (
    typeof report.rooted !== "boolean" ||
    typeof report.tampered !== "boolean"
  )
    throw invalid("Invalid integrity report");
  await t`insert into device_integrity_assessments(device_id,rooted,tampered,source,observed_at,expires_at,evidence)
    values (${device.id},${report.rooted},${report.tampered},'android-self-report',now(),now()+interval '1 day',${{ verified: false }})`;
  if (report.rooted || report.tampered)
    await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values ('device-report','device.integrity_flag','device',${device.id},${{ rooted: report.rooted, tampered: report.tampered, verified: false }})`;
}

/** @param {any} db @param {string} profileId @param {string|null} keyId @param {string} app */
export async function nativeControl(db, profileId, keyId, app) {
  if (!keyId) return null;
  const [row] =
    await db`select c.id,c.kind,c.status from device_controls c join registered_devices d on d.id=c.device_id
    where d.profile_id=${profileId} and d.key_id=${keyId} and d.app=${app} and c.status='pending' order by c.created_at limit 1`;
  return row
    ? {
        id: row.id,
        kind: row.kind,
        status: row.status,
        action: "hold_recover_then_erase",
      }
    : null;
}

/** @param {any} c @param {string} cap @param {string|null} unit */
export async function gate(c, cap, unit = null) {
  await requireCapability(c, cap, unit);
  if (!unit && c.actor.role !== "super_admin")
    throw forbidden("An assigned scope is required", "no_scope");
}
/** @param {any} c @param {string} id @param {string} [cap] */
export async function scopedDevice(c, id, cap = "admin.manage") {
  if (!isUuid(id)) throw invalid("Choose a phone");
  const [d] =
    await c.db`select * from registered_devices where id=${id} for update`;
  if (!d) throw forbidden("Phone unavailable");
  await gate(c, cap, d.org_unit_id);
  const [person] =
    await c.db`select org_unit_id from profiles where id=${d.profile_id}`;
  // F-007/F-024: an old-area device row must not authorize control of a person who moved away.
  // Missing/unassigned owners require the national super-admin, rather than leaking held work.
  await gate(c, cap, person?.org_unit_id ?? null);
  return d;
}
/** @param {any} c @param {string} action @param {string} id @param {any} details */
export async function audit(c, action, id, details) {
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values (${c.actor.subject},${action},'integrity',${id},${details})`;
}
/** @param {unknown} s */
export function reason(s) {
  if (typeof s !== "string" || !/^[a-z][a-z0-9_]{1,79}$/.test(s))
    throw invalid("Choose a short reason code");
  return s;
}
/** Current actor inside the write transaction, never a previously verified snapshot. @param {any} ctx @param {(c:any)=>Promise<any>} fn */
export async function command(ctx, fn) {
  const out = await tx(ctx.db, async (t) => {
    const actor = ctx.user ? await actorFor(t, ctx.user.id) : null;
    if (!actor) throw unauthenticated();
    const [session] = ctx.session
      ? await t`select id from sessions where id=${ctx.session.id} and revoked_at is null and expires_at>now()`
      : [];
    if (!session) throw unauthenticated();
    return fn({ ...ctx, db: t, actor });
  });
  await ctx.publish("integrity");
  return out;
}
/** F-007: suspension immediately stops business writes but control contact stays possible. @param {any} c @param {any} d @param {'wipe'|'handover'} kind @param {string} code */
export async function requestControl(c, d, kind, code) {
  const [existing] =
    await c.db`select * from device_controls where device_id=${d.id} and status='pending'`;
  if (existing) {
    if (existing.kind !== kind || existing.reason_code !== code)
      throw conflict("A different phone action is pending");
    return existing;
  }
  const [control] =
    await c.db`insert into device_controls(device_id,kind,requested_by,reason_code)
    values (${d.id},${kind},${c.actor.userId},${code}) returning *`;
  await c.db`update registered_devices set status=case when status='revoked' then 'revoked' else 'suspended' end where id=${d.id}`;
  await audit(c, `device.${kind}_requested`, d.id, {
    controlId: control.id,
    reason: code,
    queuedWork: "hold_for_review",
  });
  return control;
}
/** F-007: accept a candidate key, but DO NOT activate until old work is reconciled. @param {any} c */
export async function requestHandover(c) {
  const b = c.body,
    d = await scopedDevice(c, b.deviceId);
  if (!["field-android", "van-android", "field-ios"].includes(b.app))
    throw invalid("Choose an app");
  const bytes = Buffer.from(b.publicKeySpki ?? "", "base64");
  if (bytes.length > 256 || bytes.toString("base64") !== b.publicKeySpki)
    throw invalid("Invalid public key");
  try {
    await crypto.subtle.importKey(
      "spki",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw invalid("Invalid P-256 key");
  }
  const keyId = sha256Hex(bytes);
  if (keyId === d.key_id) throw invalid("Use the replacement phone's key");
  const tag =
    typeof b.inventoryTag === "string" && b.inventoryTag.trim().length <= 100
      ? b.inventoryTag.trim()
      : "";
  if (!tag) throw invalid("Enter the replacement asset tag");
  const code = reason(b.reasonCode);
  // Reuse prior held evidence/acknowledgment without copying or re-encrypting its original bytes.
  const [held] =
    await c.db`select * from device_controls where device_id=${d.id} and status in ('pending','acknowledged') order by (status='pending') desc,created_at desc limit 1`;
  const control = held ?? (await requestControl(c, d, "handover", code));
  const [prior] =
    await c.db`select * from device_handovers where control_id=${control.id}`;
  if (prior) {
    if (
      prior.key_id !== keyId ||
      prior.to_app !== b.app ||
      prior.inventory_tag !== tag
    )
      throw conflict("Different replacement already requested");
    return { handoverId: prior.id, status: prior.status };
  }
  const [h] =
    await c.db`insert into device_handovers(profile_id,from_device_id,to_app,public_key_spki,key_id,inventory_tag,requested_by,control_id)
    values (${d.profile_id},${d.id},${b.app},${b.publicKeySpki},${keyId},${tag},${c.actor.userId},${control.id}) returning id`;
  await audit(c, "device.handover_candidate_recorded", d.id, {
    handoverId: h.id,
    controlId: control.id,
    reason: code,
  });
  return { handoverId: h.id, status: "reconciling" };
}
/** F-007: old phone ack OR explicitly recorded lost-phone reconciliation is mandatory. @param {any} c */
export async function completeHandover(c) {
  if (!isUuid(c.body.handoverId)) throw invalid();
  const [h] =
    await c.db`select * from device_handovers where id=${c.body.handoverId} for update`;
  if (!h) throw forbidden();
  const d = await scopedDevice(c, h.from_device_id);
  const [control] =
    await c.db`select * from device_controls where id=${h.control_id}`;
  if (h.status === "completed") return { status: "completed" };
  const reconciliation = reason(c.body.reconciliation);
  if (
    control.status !== "acknowledged" &&
    reconciliation !== "lost_phone_work_unrecoverable"
  )
    throw conflict(
      "Wait for recovery and erasure, or record lost-phone work as unrecoverable",
    );
  await c.db`select pg_advisory_xact_lock(hashtext(${`device-person:${h.profile_id}`}))`;
  const p = await loadProfile(
    c.db,
    (await c.db`select user_id from profiles where id=${h.profile_id}`)[0]
      ?.user_id,
  );
  if (!p || p.status !== "active" || !p.orgUnitId)
    throw forbidden("Person is no longer assigned");
  await gate(c, "admin.manage", p.orgUnitId);
  await c.db`update registered_devices set status='revoked' where id=${d.id}`;
  await c.db`update sessions set revoked_at=now() where user_id=${p.userId} and device_key_id=${d.key_id} and revoked_at is null`;
  const [next] =
    await c.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id)
    values (${h.profile_id},${h.to_app},${h.to_app === "field-ios" ? "ios" : "android"},${h.inventory_tag},${h.public_key_spki},${h.key_id},${p.orgUnitId}) returning id`;
  await c.db`update device_handovers set status='completed',reconciliation=${reconciliation},completed_by=${c.actor.userId},completed_at=now() where id=${h.id}`;
  await audit(c, "device.handover_completed", next.id, {
    handoverId: h.id,
    reconciliation,
  });
  return { status: "completed", deviceId: next.id };
}

/** @param {Record<string,string|undefined>} env */
export async function recoveryKey(env) {
  const secret = env.DEVICE_RECOVERY_SECRET;
  if (!secret || secret.length < 32)
    throw new ApiError(
      "recovery_unconfigured",
      503,
      "Secure recovery storage needs setup",
    );
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(
      Buffer.from(sha256Hex(`device-recovery-v1|${secret}`), "hex"),
    ),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
/** Control uses its own signed message because normal challenge/push MUST refuse a suspended phone. @param {any} ctx @param {any} verifySignature @param {'recover'|'ack'} stage */
export async function controlContact(ctx, verifySignature, stage) {
  if (!ctx.actor || ctx.via !== "access" || !ctx.session?.deviceKeyId)
    throw unauthenticated();
  const b = ctx.body;
  if (
    !isUuid(b.controlId) ||
    !Number.isSafeInteger(b.timestamp) ||
    Math.abs(Date.now() - b.timestamp) > 60_000
  )
    throw invalid();
  // Native recovery signs exact UTF-8 JSON bytes, not a cross-runtime numeric re-serialization.
  let bundle = b.bundle;
  const recoveryJson =
    typeof b.bundleJson === "string"
      ? b.bundleJson
      : canonicalJson(b.bundle ?? null);
  if (stage === "recover") {
    if (Buffer.byteLength(recoveryJson) > 900_000)
      throw invalid("Recovery bundle exceeds supported size");
    try {
      bundle = JSON.parse(recoveryJson);
    } catch {
      throw invalid("Invalid recovery JSON");
    }
  }
  const digest = sha256Hex(
    stage === "recover" ? recoveryJson : canonicalJson({ digest: b.digest }),
  );
  const [d] =
    await ctx.db`select d.* from registered_devices d join device_controls c on c.device_id=d.id
    where c.id=${b.controlId} and d.profile_id=${ctx.actor.profileId} and d.key_id=${ctx.session.deviceKeyId} and d.app=${ctx.session.app}`;
  if (
    !d ||
    !(await verifySignature(
      d.public_key_spki,
      b.signature,
      `CONTROL|${stage}|${b.controlId}|${digest}|${b.timestamp}`,
    ))
  )
    throw forbidden();
  return command(ctx, async (c) => {
    const [control] =
      await c.db`select * from device_controls where id=${b.controlId} for update`;
    const [current] =
      await c.db`select * from registered_devices where id=${d.id} for update`;
    if (
      current.profile_id !== c.actor.profileId ||
      current.key_id !== c.session.deviceKeyId
    )
      throw forbidden();
    const [prior] =
      await c.db`select * from device_recovery_bundles where control_id=${control.id}`;
    if (stage === "recover") {
      if (
        !bundle ||
        !Array.isArray(bundle.tables) ||
        !Number.isSafeInteger(bundle.queuedCount) ||
        bundle.queuedCount < 0
      )
        throw invalid("Recovery bundle exceeds supported size");
      if (prior && prior.digest !== digest)
        throw conflict("A different recovery bundle is already held");
      if (!prior) {
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: new TextEncoder().encode(control.id),
          },
          await recoveryKey(c.env),
          new TextEncoder().encode(recoveryJson),
        );
        await c.db`insert into device_recovery_bundles(control_id,device_id,digest,ciphertext,nonce,queued_count)
          values (${control.id},${d.id},${digest},${Buffer.from(ciphertext).toString("base64")},${Buffer.from(nonce).toString("base64")},${bundle.queuedCount})`;
        await audit(c, "device.work_held", d.id, {
          controlId: control.id,
          queuedCount: bundle.queuedCount,
        });
      }
      return { version: 2, held: true, digest };
    }
    if (!prior || prior.digest !== b.digest)
      throw conflict("Recover saved work before confirming erasure");
    if (control.status !== "acknowledged") {
      await c.db`update device_controls set status='acknowledged',acknowledged_at=now(),queued_count=${prior.queued_count},queue_digest=${prior.digest} where id=${control.id}`;
      await c.db`update registered_devices set status='revoked' where id=${d.id}`;
      await audit(c, "device.erasure_acknowledged", d.id, {
        controlId: control.id,
        queuedCount: prior.queued_count,
      });
    }
    return { version: 2, acknowledged: true };
  });
}
