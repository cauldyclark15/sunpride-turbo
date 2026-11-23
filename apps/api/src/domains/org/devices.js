import {
  cleanHardwareText,
  phoneModelLabel,
} from "../../core/phone-hardware.js";
import { requireCapability } from "../../core/capabilities.js";
import { lockPhoneKey } from "../../core/phone-custody.js";
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
  await requireCapability(c, "phones.manage");
  const found = await access(c, "devices", uuid(b.deviceId), "phones.manage");
  await lockPhoneKey(c.db, found.key_id);
  await c.db`select pg_advisory_xact_lock(hashtext(${`device-person:${found.profile_id}`}))`;
  const device = await access(c, "devices", found.id, "phones.manage");
  await access(c, "people", device.profile_id, "phones.manage");
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
  if (action === "reinstate") {
    const person = await access(
      c,
      "people",
      device.profile_id,
      "phones.manage",
    );
    await replacePhones(c, person, device.app, device.id);
  }
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
/** Revoke this person's older registrations for this app, without deleting their work/history.
 * Caller owns the transaction and the device-person lock. @param {Ctx} c @param {Row} person
 * @param {string} app @param {string|null} [exceptId] */
async function replacePhones(c, person, app, exceptId = null) {
  const old =
    await c.db`select id,key_id from registered_devices where profile_id=${person.id}
    and app=${app} and status<>'revoked' and (${exceptId}::uuid is null or id<>${exceptId}) order by id for update`;
  for (const d of old) {
    await access(c, "devices", d.id, "phones.manage");
    await c.db`update registered_devices set status='revoked' where id=${d.id}`;
    await c.db`update sessions set revoked_at=now() where user_id=${person.user_id} and app=${app}
      and device_key_id=${d.key_id} and revoked_at is null`;
    await c.db`update device_challenges set consumed_at=now() where device_id=${d.id} and consumed_at is null`;
    await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details)
      values(${c.actor?.subject},'device.revoked','device',${d.id},${JSON.stringify({ reason: "replacement" })})`;
  }
}

/** Office registration also replaces older phones for the same app; binding still proves possession.
 * @param {Ctx} c @param {Row} b */
export async function registerDevice(c, b) {
  const person = await access(c, "people", uuid(b.profileId), "phones.manage");
  if (person.status !== "active" || !person.org_unit_id)
    rule("Choose an active assigned person");
  if (!["field-android", "van-android", "field-ios"].includes(b.app))
    rule("Choose a phone app");

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
  const label = typeof b.inventoryTag === "string" ? b.inventoryTag.trim() : "";
  const tag = required(
    label || `Phone ${keyId.slice(0, 16).toUpperCase()} (${b.app})`,
    "Phone label",
    100,
  );
  await lockPhoneKey(c.db, keyId);
  await c.db`select pg_advisory_xact_lock(hashtext(${`device-person:${person.id}`}))`;
  const existing =
    await c.db`select id,profile_id,status,public_key_spki from registered_devices where key_id=${keyId} for update`;
  if (existing.length)
    rule("This key is already registered; manage the existing phone instead");
  await replacePhones(c, person, b.app);
  // Registering with the copied phone code must retain the same report as
  // registering from the waiting list. Match the exact person, app and key.
  const [waiting] =
    await c.db`select manufacturer,model from phone_registration_requests where profile_id=${person.id} and app=${b.app} and key_id=${keyId} and status='waiting'`;
  const hardware = {
    manufacturer:
      cleanHardwareText(b.manufacturer) ??
      cleanHardwareText(waiting?.manufacturer),
    model: cleanHardwareText(b.model) ?? cleanHardwareText(waiting?.model),
  };
  const [row] =
    await c.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status,manufacturer,model)
    values(${person.id},${b.app},${b.app === "field-ios" ? "ios" : "android"},${tag},${publicKey},${keyId},${person.org_unit_id},'active',${hardware.manufacturer},${hardware.model}) returning id`;
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values(${c.actor?.subject},'device.registered','device',${row.id},'registered')`;
  return { deviceId: row.id };
}

/** @param {Ctx} c @param {Row} p */
export async function deviceReport(c, p) {
  const device = await access(c, "devices", uuid(p.deviceId), "phones.manage");
  const [person] =
    await c.db`select name,email from profiles where id=${device.profile_id}`;
  const [custody] =
    await c.db`select state from company_phone_custody where key_id=${device.key_id}`;
  /** @type {Row[]} */ const assignments =
    await c.db`select a.*,p.name as current_name from company_phone_assignments a
    left join profiles p on p.id=a.profile_id where device_id=${device.id}
    order by effective_from desc,id desc limit 101`;
  /** @type {Row[]} */ const operations =
    await c.db`select client_op_id,op_type,status,ack,server_time from op_receipts where device_id=${device.id} order by server_time desc limit 100`;
  /** @type {Row[]} */ const audits =
    await c.db`select a.action,a.created_at,a.details,p.name as actor_name from audit_logs a left join profiles p on p.auth_subject=a.subject where a.entity_id=${device.id} order by a.created_at desc limit 100`;
  return {
    device: {
      deviceId: device.id,
      inventoryTag: device.inventory_tag,
      status: device.status,
      profileId: device.profile_id,
      lost: custody?.state === "lost",
      employeeName: person?.name ?? "Former user",
      lastSeenAt: ms(device.last_seen_at),
      statusAt: null,
      offlineLeaseExpiresAt: null,
      allowedApp: device.app,
      model: phoneModelLabel(device),
      platform: device.platform,
    },
    profile: {
      name: person?.name ?? "Former user",
      email: person?.email ?? null,
    },
    assignments: assignments.slice(0, 100).map((r) => ({
      id: r.id,
      personName: r.person_name ?? r.current_name ?? "Former user",
      from: ms(r.effective_from),
      to: ms(r.effective_to),
    })),
    assignmentsMore: assignments.length > 100,
    lastAcknowledgedAt: ms(operations[0]?.server_time),
    history: audits.map((r) => ({
      action: r.action,
      at: ms(r.created_at),
      actorName: r.actor_name ?? "Former user",
      reason: historyReason(r.details),
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

/**
 * FLD-013: audit details are a bare reason code (office commands) or a JSON object (phone/handover events; older
 * rows were stored as the literal "[object Object]"). The history shows only a reason code, never raw details.
 * @param {unknown} details @returns {string|null}
 */
export function historyReason(details) {
  if (typeof details !== "string") return null;
  const code = /^[a-z][a-z0-9_]{1,79}$/;
  if (code.test(details)) return details;
  try {
    const parsed = JSON.parse(details);
    return typeof parsed?.reason === "string" && code.test(parsed.reason)
      ? parsed.reason
      : null;
  } catch {
    return null;
  }
}
