import { loadProfile } from "./hooks.js";
import { forbidden, invalid } from "./errors.js";

/** FLD-014/E2E-004: what a person sees when signing in on a phone the office revoked. */
export const PHONE_REMOVED_MESSAGE =
  "This phone was removed by the office. Your unsent work is kept on this phone. Give the phone to your supervisor so the office can recover it.";

/**
 * FLD-014/E2E-004: a revoked phone never gets a new session. The key is refused when every row this person has for
 * it (same app) is revoked and the office has no pending recovery/erasure control on it (that path signs in to upload
 * the held work, then erases). A phone the person never registered, or a suspended one, keeps the existing flow.
 * @param {any} t @param {string} userId @param {string} app @param {string|null} keyId
 */
export async function refuseRevokedPhone(t, userId, app, keyId) {
  if (!keyId) return;
  const profile = await loadProfile(t, userId);
  if (!profile) return;
  const rows =
    await t`select id, status from registered_devices where profile_id=${profile.id} and key_id=${keyId} and app=${app}`;
  if (!rows.length || rows.some((/** @type {any} */ r) => r.status !== "revoked")) return;
  const [control] =
    await t`select 1 from device_controls c join registered_devices d on d.id=c.device_id
      where d.profile_id=${profile.id} and d.key_id=${keyId} and d.app=${app} and c.status='pending' limit 1`;
  if (control) return;
  throw forbidden(PHONE_REMOVED_MESSAGE, "device_revoked");
}

/**
 * Sample-company first sign-in may register a phone, never restore/replace one.
 * Binding still requires the normal single-use P-256 possession proof. A password
 * alone must not create a trusted bound credential.
 * Caller holds the user row lock and owns the transaction.
 * @param {any} t @param {string} userId @param {string} app @param {any} key
 */
export async function registerSamplePhone(t, userId, app, key) {
  if (!key?.publicKeySpki) return;
  // SP-0165: office clients never register a handheld (they carry no device key).
  if (app === "office-ios") return;
  const profile = await loadProfile(t, userId);
  if (!profile || profile.status !== "active" || !profile.orgUnitId) return;
  const sample =
    await t`select 1 from sample_data_rows where table_name='profiles' and row_id=${profile.id} limit 1`;
  if (!sample.length) return;
  // The request parser already checks the canonical base64 digest; also require a genuine P-256 key.
  try {
    await crypto.subtle.importKey(
      "spki",
      Buffer.from(key.publicKeySpki, "base64"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw invalid("Invalid P-256 public key");
  }
  // F-007: only the very first phone self-registers. Even permanent retirement needs an
  // explicit controlled reconciliation before a replacement; a new key cannot bypass old queued work.
  // A shared demo phone may still carry several sample accounts, each with its own row and bind.
  const existing =
    await t`select id from registered_devices where profile_id=${profile.id} limit 1`;
  if (existing.length) return;
  const [device] = await t`insert into registered_devices
    (profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id)
    values (${profile.id},${app},${app === "field-ios" ? "ios" : "android"},
      ${`SAMPLE-${crypto.randomUUID()}`},${key.publicKeySpki},${key.keyId},${profile.orgUnitId}) returning id`;
  await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values (${userId},'device.sample_registered','device',${device.id},${JSON.stringify({ app, sample: true, binding: "proof_required" })})`;
}
