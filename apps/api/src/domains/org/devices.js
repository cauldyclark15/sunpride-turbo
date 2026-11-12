import { requireCapability } from "../../core/capabilities.js";
import { access } from "./readers.js";
import {
  dto,
  get,
  history,
  integer,
  ms,
  required,
  rule,
  update,
  uuid,
} from "./model.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */
const REASONS = {
  suspend: ["lost", "stolen", "suspected_compromise", "other"],
  revoke: [
    "lost",
    "stolen",
    "suspected_compromise",
    "replacement",
    "transfer",
    "decommissioned",
    "other",
  ],
  reinstate: ["found", "other"],
};
/** @param {Ctx} c @param {'suspend'|'revoke'|'reinstate'} action @param {Row} b */
export async function deviceCommand(c, action, b) {
  await requireCapability(c, "admin.manage");
  const device = await access(c, "devices", uuid(b.deviceId), "admin.manage");
  if (!REASONS[action].includes(b.reason)) rule("Choose a reason code");
  if (
    device.status === "revoked" ||
    (action === "reinstate" && device.status !== "suspended") ||
    (action === "suspend" && device.status !== "active")
  )
    rule("Invalid phone status transition");
  // F-007: ordinary admin routes must not bypass the recovery hold.
  if (
    action === "reinstate" &&
    (
      await c.db`select 1 from device_controls where device_id=${device.id} and status='pending' limit 1`
    ).length
  )
    rule(
      "Finish the pending recovery or handover before reinstating this phone",
    );
  await update(c.db, "registered_devices", device.id, {
    status:
      action === "suspend"
        ? "suspended"
        : action === "revoke"
          ? "revoked"
          : "active",
  });
  if (action === "revoke")
    await c.db`update sessions set revoked_at=now() where user_id=(select user_id from profiles where id=${device.profile_id}) and device_key_id=${device.key_id} and revoked_at is null`;
  if (action === "suspend")
    // VAN-086: a pause is not a sign-out. The phone's short-lived access ends now, and every refresh answers
    // 403 device_suspended ("This phone is paused") until the phone is reinstated; the session and the work kept
    // on the phone stay, so a reinstated phone carries on without a new sign-in.
    await c.db`delete from access_tokens where session_id in (select id from sessions where user_id=(select user_id from profiles where id=${device.profile_id}) and device_key_id=${device.key_id} and revoked_at is null)`;
  if (action !== "reinstate")
    await c.db`update device_challenges set consumed_at=now() where device_id=${device.id} and consumed_at is null`;
  return null;
}
/** Admin-only registration; does not bind, reassign or revive any existing key. @param {Ctx} c @param {Row} b */
export async function registerDevice(c, b) {
  const person = await access(c, "people", uuid(b.profileId), "admin.manage");
  if (person.status !== "active" || !person.org_unit_id)
    rule("Choose an active assigned person");
  if (!["field-android", "van-android", "field-ios"].includes(b.app))
    rule("Choose a phone app");
  const tag = required(b.inventoryTag, "Phone inventory tag", 100);
  const publicKey = required(b.publicKeySpki, "Public key", 512);
  const bytes = Buffer.from(publicKey, "base64");
  if (bytes.toString("base64") !== publicKey || bytes.length > 256)
    rule("Invalid public key");
  try {
    await crypto.subtle.importKey(
      "spki",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    rule("Invalid P-256 public key");
  }
  const keyId = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const existing =
    await c.db`select id,profile_id,status,public_key_spki from registered_devices where key_id=${keyId} and app=${b.app} for update`;
  if (existing.length)
    rule("This key is already registered; manage the existing phone instead");
  if (
    (
      await c.db`select 1 from registered_devices where profile_id=${person.id} limit 1`
    ).length
  )
    rule(
      "Use a controlled handover to reconcile this person’s existing phone first",
    );
  const [row] =
    await c.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status)
    values(${person.id},${b.app},${b.app === "field-ios" ? "ios" : "android"},${tag},${publicKey},${keyId},${person.org_unit_id},'active') returning id`;
  return { deviceId: row.id };
}

/** @param {Ctx} c @param {Row} p */
export async function deviceReport(c, p) {
  const device = await access(c, "devices", uuid(p.deviceId), "admin.manage");
  const person = await get(c.db, "profiles", device.profile_id);
  /** @type {Row[]} */ const operations =
    await c.db`select client_op_id,op_type,status,ack,server_time from op_receipts where device_id=${device.id} order by server_time desc limit 100`;
  /** @type {Row[]} */ const audits =
    await c.db`select a.action,a.created_at,a.details,p.name as actor_name from audit_logs a left join profiles p on p.auth_subject=a.subject where a.entity_id=${device.id} order by a.created_at desc limit 100`;
  return {
    device: {
      deviceId: device.id,
      inventoryTag: device.inventory_tag,
      status: device.status,
      employeeName: person.name,
      lastSeenAt: ms(device.last_seen_at),
      statusAt: null,
      offlineLeaseExpiresAt: null,
      allowedApp: device.app,
      model: "Not recorded",
      platform: device.platform,
    },
    profile: { name: person.name, email: person.email },
    lastAcknowledgedAt: ms(operations[0]?.server_time),
    history: audits.map((r) => ({
      action: r.action,
      at: ms(r.created_at),
      actorName: r.actor_name ?? "Former user",
      reason: r.details,
    })),
    acknowledged: operations.map((r) => ({
      kind: r.op_type,
      serverAt: ms(r.server_time),
      clientRequestId: r.client_op_id,
    })),
    acknowledgedMore: operations.length === 100,
    warning:
      "Unsynced work may exist only on this phone. Revocation is permanent; reconcile before recapture.",
  };
}
