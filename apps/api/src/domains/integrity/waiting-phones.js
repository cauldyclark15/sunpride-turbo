import { loadProfile } from "../../core/hooks.js";
import { requireCapability } from "../../core/capabilities.js";
import { conflict, invalid } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";
import { registerDevice } from "../org/devices.js";
import { scopeFilterForActor } from "../org/scope.js";
import { audit } from "./governance.js";

const APPS = ["field-android", "van-android"];

/**
 * SP-0174: a person signed in on a phone the office has not registered. Remember the phone (its public key, which
 * the sign-in already checked against its key id) so Setup > Phones can list it under "Phones waiting to be
 * registered". Only a person's FIRST phone for that app waits here; a replacement keeps the controlled handover.
 * Never fails the sign-in: anything unusual simply records nothing. Caller owns the transaction.
 * @param {any} t @param {string} userId @param {string} app @param {any} key
 */
export async function noteWaitingPhone(t, userId, app, key) {
  if (!APPS.includes(app) || typeof key?.publicKeySpki !== "string") return;
  const profile = await loadProfile(t, userId);
  if (!profile || profile.status !== "active" || !profile.orgUnitId) return;
  try {
    await crypto.subtle.importKey(
      "spki",
      Buffer.from(key.publicKeySpki, "base64"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return;
  }
  const [has] =
    await t`select 1 from registered_devices where profile_id=${profile.id} limit 1`;
  if (has) return;
  const [waiting] =
    await t`select id from phone_registration_requests where profile_id=${profile.id} and app=${app} and key_id=${key.keyId} and status='waiting'`;
  if (waiting)
    await t`update phone_registration_requests set last_seen_at=now() where id=${waiting.id}`;
  else
    await t`insert into phone_registration_requests(profile_id,app,key_id,public_key_spki) values(${profile.id},${app},${key.keyId},${key.publicKeySpki})`;
}

/** The short code both phone apps show on their Register screen (first 16 of the key id, in groups of 4). @param {string} keyId */
export const phoneCode = (keyId) =>
  (keyId.slice(0, 16).toUpperCase().match(/.{4}/g) ?? []).join(" ");

/** Waiting phones of people in the caller's areas who still have no phone. @param {any} c @param {string[]} ids */
export async function waitingPhones(c, ids) {
  const rows =
    await c.db`select r.id,r.app,r.key_id,r.requested_at,r.last_seen_at,p.id as profile_id,p.name as person
      from phone_registration_requests r join profiles p on p.id=r.profile_id
      where r.status='waiting' and p.deleted_at is null and p.status='active'
        and p.org_unit_id in ${c.db(ids.length ? ids : [null])}
        and not exists (select 1 from registered_devices d where d.profile_id=r.profile_id)
        and r.last_seen_at > now() - interval '30 days'
      order by r.last_seen_at desc limit 200`;
  return rows.map((/** @type {any} */ r) => ({
    id: r.id,
    personId: r.profile_id,
    person: r.person,
    app: r.app,
    phoneCode: phoneCode(r.key_id),
    requestedAt: new Date(r.requested_at).getTime(),
    lastSeenAt: new Date(r.last_seen_at).getTime(),
  }));
}

/** @param {any} c @param {unknown} id */
async function lockWaiting(c, id) {
  if (!isUuid(id)) throw invalid("Choose a waiting phone");
  const [r] =
    await c.db`select * from phone_registration_requests where id=${id} for update`;
  if (!r) throw invalid("Choose a waiting phone");
  if (r.status !== "waiting")
    throw conflict("This phone was already registered or rejected");
  return r;
}

/** Register a waiting phone as the person's first phone. Same rules as registering by code. @param {any} c */
export async function registerWaitingPhone(c) {
  await requireCapability(c, "admin.manage");
  const r = await lockWaiting(c, c.body?.requestId);
  const label =
    typeof c.body?.inventoryTag === "string" && c.body.inventoryTag.trim()
      ? c.body.inventoryTag.trim()
      : `Phone ${phoneCode(r.key_id)}`;
  // registerDevice re-checks: admin in the person's area, active assigned person, no phone yet, key unused.
  const { deviceId } = await registerDevice(c, {
    profileId: r.profile_id,
    app: r.app,
    inventoryTag: label,
    publicKeySpki: r.public_key_spki,
  });
  await c.db`update phone_registration_requests set status='registered',decided_at=now(),decided_by=${c.actor.subject},device_id=${deviceId} where id=${r.id}`;
  await c.db`update phone_registration_requests set status='superseded',decided_at=now(),decided_by=${c.actor.subject} where profile_id=${r.profile_id} and status='waiting'`;
  await audit(c, "device.registered_from_waiting", deviceId, {
    app: r.app,
    request: r.id,
  });
  return { deviceId };
}

/** Turn a waiting phone away (e.g. the wrong person signed in on it). It can ask again by signing in. @param {any} c */
export async function rejectWaitingPhone(c) {
  await requireCapability(c, "admin.manage");
  const r = await lockWaiting(c, c.body?.requestId);
  const [scoped] =
    await c.db`select 1 from profiles where id=${r.profile_id} and org_unit_id in ${c.db(await scopeIds(c))}`;
  if (!scoped) throw invalid("Choose a waiting phone");
  await c.db`update phone_registration_requests set status='rejected',decided_at=now(),decided_by=${c.actor.subject} where id=${r.id}`;
  await audit(c, "device.waiting_rejected", r.id, { app: r.app });
  return null;
}

/** @param {any} c @returns {Promise<any[]>} */
async function scopeIds(c) {
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  const ids =
    unitIds ??
    (await c.db`select id from org_units where deleted_at is null`).map(
      (/** @type {any} */ r) => r.id,
    );
  return ids.length ? ids : [null];
}
