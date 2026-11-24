import { loadProfile } from "../../core/hooks.js";
import { sha256Hex } from "../../core/util.js";
import { phoneCode } from "./waiting-phones.js";
import { queuePhoneCommand } from "../../core/phone-commands.js";

/** Handheld apps whose phones a super_admin registers by signing in (never the office iPhone app). */
const APPS = ["field-android", "van-android", "field-ios"];
export const SUPERADMIN_AUTO_REASON = "superadmin_auto_approval";
/** SP-0209: reason for a store-review account (profiles.phone_auto_approve, set only by create-play-reviewer.js). */
export const REVIEW_AUTO_REASON = "review_account_auto_approval";

/**
 * SP-0193: the system owner (role super_admin) never waits on "Register phone". The first sign-in on a phone — or,
 * for a phone already waiting, its next status check (GET /api/me) — registers it at once, exactly as an admin
 * approving it from Setup > Phones would, audited with the super_admin as the actor. A super_admin may keep several
 * phones active (rows carry `superadmin_auto`, outside the one-active-phone rule); no other phone is touched.
 * A key the office already has a row for (revoked, paused or active) is left alone: auto-approval never revives a
 * phone the office removed. Every other role keeps the existing flow. Caller owns the transaction.
 * @param {any} t @param {string} userId @param {string} app
 * @param {any} key {keyId, publicKeySpki?}
 * @returns {Promise<string|null>} the new device id, or null when nothing was registered
 */
export async function autoApproveSuperadminPhone(t, userId, app, key) {
  if (!APPS.includes(app) || typeof key?.keyId !== "string") return null;
  const keyId = key.keyId;
  const profile = await loadProfile(t, userId);
  if (!profile || profile.status !== "active" || !profile.orgUnitId)
    return null;
  const [stored] =
    await t`select id,role,status,org_unit_id,phone_auto_approve,phone_office_auto_accept from profiles where id=${profile.id} and deleted_at is null`;
  // SP-0209: a store-review account flagged by create-play-reviewer.js is treated like the owner here.
  const review =
    stored?.phone_auto_approve === true && stored.role !== "super_admin";
  if (
    !stored ||
    (profile.role !== "super_admin" && !review && !stored.phone_office_auto_accept) ||
    stored.role !== profile.role ||
    stored.status !== "active" ||
    stored.org_unit_id !== profile.orgUnitId
  )
    return null;
  await t`select pg_advisory_xact_lock(hashtext(${`device-person:${profile.id}`}))`;
  // Any row for this key (any person, any status) means the office already decided about this phone.
  const [known] =
    await t`select 1 from registered_devices where key_id=${keyId} and app=${app} limit 1`;
  if (known) return null;
  const [waiting] =
    await t`select id,public_key_spki from phone_registration_requests where profile_id=${profile.id} and app=${app} and key_id=${keyId} and status='waiting' order by last_seen_at desc limit 1`;
  const spki =
    typeof key.publicKeySpki === "string"
      ? key.publicKeySpki
      : (waiting?.public_key_spki ?? null);
  if (typeof spki !== "string" || spki.length > 512) return null;
  const bytes = Buffer.from(spki, "base64");
  if (bytes.toString("base64") !== spki || sha256Hex(bytes) !== keyId)
    return null;
  try {
    await crypto.subtle.importKey(
      "spki",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
  const extra = review || profile.role === "super_admin";
  if (!extra) {
    const old = await t`select * from registered_devices where profile_id=${profile.id} and app=${app} and status<>'revoked' order by id for update`;
    for (const d of old) await queuePhoneCommand(t, d, "remove", userId);
  }
  const tag = `${review ? "Review" : extra ? "Owner" : "Accepted"} phone ${phoneCode(keyId)}${app === "field-android" ? "" : ` (${app})`}`;
  const [device] =
    await t`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status,superadmin_auto)
    values(${profile.id},${app},${app === "field-ios" ? "ios" : "android"},${tag},${spki},${keyId},${profile.orgUnitId},'active',${extra})
    returning id`;
  // Same bookkeeping as an admin registering a waiting phone (waiting-phones.js), with the owner as the decider.
  if (waiting)
    await t`update phone_registration_requests set status='registered',decided_at=now(),decided_by=${userId},device_id=${device.id} where id=${waiting.id}`;
  await t`update phone_registration_requests set status='superseded',decided_at=now(),decided_by=${userId} where profile_id=${profile.id} and app=${app} and key_id=${keyId} and status='waiting'`;
  await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values (${userId},'device.registered_from_waiting','integrity',${device.id},${JSON.stringify(
      {
        app,
        request: waiting?.id ?? null,
        reason: review ? REVIEW_AUTO_REASON : extra ? SUPERADMIN_AUTO_REASON : "office_auto_accept",
        note: review
          ? "store-review account auto-approval"
          : extra ? "superadmin auto-approval" : "Office enabled automatic acceptance",
      },
    )})`;
  return device.id;
}
