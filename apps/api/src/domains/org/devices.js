import { requireCapability } from "../../core/capabilities.js";
import { access } from "./readers.js";
import { ApiError } from "../../core/errors.js";
import { createPublicKey } from "node:crypto";
import { sha256Hex } from "../../core/util.js";
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
/** Admin registration never replaces a bound key or revives a removed device. @param {Ctx} c @param {Row} b */
export async function registerDevice(c, b) {
  await requireCapability(c, "admin.manage");
  const profile = await access(c, "people", uuid(b.profileId), "admin.manage");
  if (profile.status !== "active") rule("Choose an active person");
  if (!["field-ios", "field-android", "van-android"].includes(b.app)) rule("Choose a supported app");
  const publicKeySpki = required(b.publicKeySpki, "Phone public key", 512);
  const bytes = Buffer.from(publicKeySpki, "base64");
  if (publicKeySpki !== b.publicKeySpki || bytes.length !== 91 || bytes.toString("base64") !== publicKeySpki) rule("Invalid phone public key");
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") rule("Invalid phone public key");
  } catch { rule("Invalid phone public key"); }
  const keyId = sha256Hex(bytes);
  if (b.keyId !== undefined && b.keyId !== keyId) rule("Phone key identifier does not match");
  const tag = required(b.inventoryTag, "Phone label", 100);
  const existing = await c.db`select * from registered_devices where profile_id=${profile.id} and app=${b.app} and status='active'`;
  if (existing.length) {
    if (existing[0].key_id === keyId && existing[0].inventory_tag === tag) return existing[0].id;
    throw new ApiError("device_exists", 409, "This person already has an active phone for this app");
  }
  // A shared phone may be registered for several people: every lookup, binding and proof is scoped to the
  // signed-in profile, and each person binds their own credential. One person never gets two active phones.
  const [row] = await c.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status)
    values(${profile.id},${b.app},${b.app === "field-ios" ? "ios" : "android"},${tag},${publicKeySpki},${keyId},${profile.org_unit_id},'active') returning id`;
  return row.id;
}

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
  await update(c.db, "registered_devices", device.id, {
    status:
      action === "suspend"
        ? "suspended"
        : action === "revoke"
          ? "revoked"
          : "active",
  });
  if (action !== "reinstate") {
    await c.db`update sessions set revoked_at=now() where user_id=(select user_id from profiles where id=${device.profile_id}) and device_key_id=${device.key_id} and revoked_at is null`;
    await c.db`update device_challenges set consumed_at=now() where device_id=${device.id} and consumed_at is null`;
  }
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
