import { tx } from "@sunpride/db/client";
import {
  recordDeviceAssessment,
  requireDeviceIntegrity,
} from "../domains/integrity/governance.js";
import { actorFor } from "./context.js";
import {
  ApiError,
  conflict,
  forbidden,
  invalid,
  NOT_SET_UP_MESSAGE,
  unauthenticated,
} from "./errors.js";
import {
  CHALLENGE_POLICY,
  FAILURE_POLICY,
  backoff,
  challengeKey,
  failureKey,
  refund,
  take,
  takeOrThrow,
} from "./rate.js";
import { isPlainObject, isUuid, sha256Hex } from "./util.js";

export const CHALLENGE_TTL_MS = 60_000;
export const PROOF_SKEW_MS = 60_000;
/** Paths a bound native device may sign (D1/D2). Bind uses its own BIND message. */
export const SIGNED_PATHS = Object.freeze([
  "/api/sync/pull",
  "/api/sync/push",
  "/api/media/claims",
]);
/** Proof headers (v2). */
export const PROOF_HEADERS = Object.freeze({
  deviceId: "x-device-id",
  nonce: "x-device-nonce",
  timestamp: "x-device-timestamp",
  signature: "x-device-signature",
});

const enc = new TextEncoder();

/** Canonical standard base64 → bytes, or null. @param {unknown} value @param {number} maxBytes */
function decodeB64(value, maxBytes) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    value.length > maxBytes * 2
  )
    return null;
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.toString("base64") !== value
  )
    return null;
  return new Uint8Array(bytes);
}

/** Verify a P1363 ECDSA P-256/SHA-256 signature over `message` with base64 SPKI. */
export async function verifySignature(
  /** @type {string} */ spki,
  /** @type {unknown} */ proof,
  /** @type {string} */ message,
) {
  const keyBytes = decodeB64(spki, 256);
  const sig = decodeB64(proof, 128);
  if (!keyBytes || !sig || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      sig,
      enc.encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * Persisted device + owner checks (devices.ts `devicePerson`). Transfers need re-enrolment.
 * @param {any} db @param {import('./context.js').Actor|null} actor @param {unknown} deviceId
 * @param {{ lock?: boolean }} [opts]
 */
export async function devicePerson(db, actor, deviceId, opts = {}) {
  if (!actor)
    throw forbidden(
      "No active profile for this account",
      "profile_unavailable",
    );
  if (!isUuid(deviceId)) throw invalid("Invalid deviceId");
  const rows = opts.lock
    ? await db`select * from registered_devices where id = ${deviceId} for share`
    : await db`select * from registered_devices where id = ${deviceId}`;
  const device = rows[0];
  if (!device || device.profile_id !== actor.profileId)
    throw forbidden("Device unavailable", "device_unavailable");
  if (device.status === "revoked")
    throw forbidden(NOT_SET_UP_MESSAGE, "device_not_set_up_for_you");
  if (device.status === "suspended")
    throw forbidden("Device suspended", "device_suspended");
  if (!device.org_unit_id || device.org_unit_id !== actor.orgUnitId)
    throw forbidden("Device scope changed", "scope_withdrawn");
  if (device.bound_subject && device.bound_subject !== actor.subject)
    throw forbidden("Device identity mismatch", "device_unavailable");
  await requireDeviceIntegrity(db, device);
  return device;
}

/**
 * Re-check the actor and device inside an operation transaction (D2: before idempotent replay).
 * @param {any} t transaction handle @param {import('./context.js').Actor} actor @param {string} deviceId
 */
export async function reauthorizeDevice(t, actor, deviceId) {
  const current = await actorFor(t, actor.userId);
  if (
    !current ||
    current.profileId !== actor.profileId ||
    current.role !== actor.role ||
    current.orgUnitId !== actor.orgUnitId
  )
    throw forbidden("Your access changed", "scope_withdrawn");
  const users =
    await t`select disabled_at from users where id = ${actor.userId}`;
  if (!users[0] || users[0].disabled_at)
    throw unauthenticated("Account disabled");
  const device = await devicePerson(t, current, deviceId, { lock: true });
  if (device.bound_subject !== current.subject || !device.credential_id)
    throw forbidden("Device not bound", "device_unbound");
  return { actor: current, device };
}

/** Mark one challenge used; false if missing, expired or already used. @param {any} db @param {string} deviceId @param {unknown} nonce */
async function consumeNonce(db, deviceId, nonce) {
  if (!isUuid(nonce)) return false;
  const rows = await db`
    update device_challenges set consumed_at = now(), updated_at = now()
    where device_id = ${deviceId} and nonce = ${nonce} and consumed_at is null
      and expires_at > now() and issued_at <= now()
    returning id`;
  return rows.length === 1;
}

const proofError = () =>
  new ApiError("device_proof_invalid", 401, "Device proof rejected", true, {
    action: "retry",
  });

/**
 * Verify the signed native request (D2): bearer actor + ECDSA P-256 P1363 over
 * `METHOD|path|sha256(rawBody)|nonce|timestamp`, 60 s skew, single-use nonce, rate budget.
 * Sets and returns `ctx.device`.
 * @param {import('./context.js').Ctx} ctx
 */
export async function verifyDeviceProof(ctx) {
  ctx.v2 = true;
  if (!ctx.actor || ctx.via !== "access" || !ctx.session) {
    if (!ctx.user) throw unauthenticated();
    throw forbidden(
      "No active profile for this account",
      "profile_unavailable",
    );
  }
  const h = ctx.req.headers;
  const deviceId = h.get(PROOF_HEADERS.deviceId);
  const nonce = h.get(PROOF_HEADERS.nonce);
  const timestampText = h.get(PROOF_HEADERS.timestamp);
  const signature = h.get(PROOF_HEADERS.signature);
  if (!deviceId || !nonce || !timestampText || !signature)
    throw invalid("Missing device proof headers", "device_proof_missing");
  if (
    isPlainObject(ctx.body) &&
    ctx.body.deviceId !== undefined &&
    ctx.body.deviceId !== deviceId
  )
    throw invalid("Body deviceId does not match the proof");
  if (
    isPlainObject(ctx.body) &&
    ctx.body.app !== undefined &&
    ctx.body.app !== ctx.session.app
  )
    throw invalid("Body app does not match the session");
  const method = ctx.req.method;
  const path = ctx.url.pathname;
  if (method !== "POST" || !SIGNED_PATHS.includes(path))
    throw invalid("Path is not signable");
  const device = await devicePerson(ctx.db, ctx.actor, deviceId);
  if (device.bound_subject !== ctx.actor.subject || !device.credential_id)
    throw forbidden("Device not bound", "device_unbound");
  if (device.app !== ctx.session.app)
    throw forbidden("Device belongs to another app", "device_unavailable");
  const subjectKey = failureKey(ctx.actor.subject);
  // Reserve one invalid-attempt unit before any expensive work; refunded when the proof is valid.
  const wait = await take(ctx.db, subjectKey, FAILURE_POLICY);
  if (wait > 0)
    throw new ApiError("rate_limited", 429, "Too many invalid requests", true, {
      action: "retry",
      retryAfterMs: wait,
    });
  const timestamp = Number(timestampText);
  if (
    !/^\d{1,16}$/.test(timestampText) ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(timestamp - Date.now()) > PROOF_SKEW_MS
  )
    throw proofError();
  const digest = sha256Hex(ctx.rawBody);
  const message = `${method}|${path}|${digest}|${nonce}|${timestamp}`;
  if (!(await verifySignature(device.public_key_spki, signature, message)))
    throw proofError();
  if (!(await consumeNonce(ctx.db, device.id, nonce))) throw proofError();
  await refund(ctx.db, subjectKey);
  await ctx.db`update registered_devices set last_seen_at = now() where id = ${device.id}`;
  ctx.device = device;
  return device;
}

/** @param {import('./router.js').Router} router */
export function installDevices(router) {
  router.post(
    "/api/devices/challenge",
    async (ctx) => {
      if (!ctx.user) throw unauthenticated();
      const body = ctx.body;
      if (!isPlainObject(body) || body.version !== 2)
        throw new ApiError(
          "version_unsupported",
          426,
          "Protocol version 2 required",
          false,
          { action: "update" },
        );
      if (ctx.actor && isUuid(body.deviceId) && body.integrity != null) {
        const [reported] =
          await ctx.db`select * from registered_devices where id=${body.deviceId} and profile_id=${ctx.actor.profileId} and key_id=${ctx.session?.deviceKeyId ?? null} and app=${ctx.session?.app ?? null}`;
        if (reported)
          await recordDeviceAssessment(ctx.db, reported, body.integrity);
      }
      const device = await devicePerson(ctx.db, ctx.actor, body.deviceId);
      const subject = /** @type {import('./context.js').Actor} */ (ctx.actor)
        .subject;
      const wait = await backoff(ctx.db, failureKey(subject), FAILURE_POLICY);
      if (wait > 0)
        throw new ApiError(
          "rate_limited",
          429,
          "Too many invalid requests",
          true,
          { action: "retry", retryAfterMs: wait },
        );
      await takeOrThrow(ctx.db, challengeKey(device.id), CHALLENGE_POLICY);
      const nonce = crypto.randomUUID();
      const [row] = await ctx.db`
        insert into device_challenges (device_id, nonce, expires_at)
        values (${device.id}, ${nonce}, now() + make_interval(secs => ${CHALLENGE_TTL_MS / 1000}))
        returning issued_at, expires_at`;
      // Opportunistic cleanup of this device's stale challenges.
      await ctx.db`delete from device_challenges where device_id = ${device.id} and expires_at < now() - interval '1 hour'`;
      return {
        version: 2,
        nonce,
        serverTime: new Date(row.issued_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
      };
    },
    { v2: true },
  );

  router.post(
    "/api/devices/bind",
    async (ctx) => {
      if (!ctx.user) throw unauthenticated();
      const body = ctx.body;
      if (!isPlainObject(body) || body.version !== 2)
        throw new ApiError(
          "version_unsupported",
          426,
          "Protocol version 2 required",
          false,
          { action: "update" },
        );
      const device = await devicePerson(ctx.db, ctx.actor, body.deviceId);
      const actor = /** @type {import('./context.js').Actor} */ (ctx.actor);
      if (device.bound_subject || device.credential_id)
        throw conflict("Device already bound", "already_bound");
      if (!ctx.session || device.app !== ctx.session.app)
        throw forbidden("Device belongs to another app", "device_unavailable");
      const credentialId = body.credentialId;
      if (
        typeof credentialId !== "string" ||
        !credentialId ||
        credentialId.length > 128 ||
        credentialId.includes("|")
      )
        throw invalid("Invalid credentialId");
      const att = body.attestation;
      if (
        !isPlainObject(att) ||
        typeof att.format !== "string" ||
        !att.format ||
        att.format.length > 64 ||
        !(
          att.keyId === undefined ||
          att.keyId === null ||
          (typeof att.keyId === "string" && att.keyId.length <= 128)
        )
      )
        throw invalid("Invalid attestation");
      const taken =
        await ctx.db`select 1 from registered_devices where credential_id = ${credentialId}`;
      if (taken.length)
        throw conflict("Credential already registered", "credential_taken");
      const subjectKey = failureKey(actor.subject);
      const wait = await take(ctx.db, subjectKey, FAILURE_POLICY);
      if (wait > 0)
        throw new ApiError(
          "rate_limited",
          429,
          "Too many invalid requests",
          true,
          { action: "retry", retryAfterMs: wait },
        );
      const rejected = { version: 2, bindingStatus: "rejected" };
      const timestamp = body.timestamp;
      if (
        typeof timestamp !== "number" ||
        !Number.isSafeInteger(timestamp) ||
        Math.abs(timestamp - Date.now()) > PROOF_SKEW_MS
      )
        return rejected;
      // Burn the nonce first: one signature verification per issued challenge.
      if (!(await consumeNonce(ctx.db, device.id, body.nonce))) return rejected;
      const message = `BIND|${device.id}|${credentialId}|${body.nonce}|${timestamp}`;
      if (!(await verifySignature(device.public_key_spki, body.proof, message)))
        return rejected;
      await tx(ctx.db, async (t) => {
        const current = await actorFor(t, actor.userId);
        if (
          !current ||
          current.profileId !== actor.profileId ||
          current.role !== actor.role ||
          current.orgUnitId !== actor.orgUnitId
        )
          throw forbidden("Your access changed", "scope_withdrawn");
        await devicePerson(t, current, device.id, { lock: true });
        const updated = await t`
        update registered_devices
        set bound_subject = ${actor.subject}, credential_id = ${credentialId}, bound_at = now(),
            attestation = ${{ format: att.format, keyId: att.keyId ?? null, verified: false }}
        where id = ${device.id} and bound_subject is null and credential_id is null and status = 'active'
        returning id`;
        if (!updated.length)
          throw conflict("Device already bound", "already_bound");
        await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
        values (${actor.subject},'device.bound','device',${device.id},${{ app: device.app, verified: false }})`;
      });
      await refund(ctx.db, subjectKey);
      return { version: 2, bindingStatus: "bound" };
    },
    { v2: true },
  );
}
