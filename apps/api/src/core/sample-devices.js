import { loadProfile } from "./hooks.js";
import { invalid } from "./errors.js";

/**
 * Sample-company first sign-in may register a phone, never restore/replace one.
 * Binding still requires the normal single-use P-256 possession proof. A password
 * alone must not create a trusted bound credential.
 * Caller holds the user row lock and owns the transaction.
 * @param {any} t @param {string} userId @param {string} app @param {any} key
 */
export async function registerSamplePhone(t, userId, app, key) {
  if (!key?.publicKeySpki) return;
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
  // One row per person and app. A shared demo phone may carry several sample accounts: every row is
  // looked up by profile, and each binds with its own fresh credential and possession proof.
  const existing = await t`select id from registered_devices
    where profile_id=${profile.id} and app=${app} limit 1`;
  if (existing.length) return;
  const [device] = await t`insert into registered_devices
    (profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id)
    values (${profile.id},${app},${app === "field-ios" ? "ios" : "android"},
      ${`SAMPLE-${crypto.randomUUID()}`},${key.publicKeySpki},${key.keyId},${profile.orgUnitId}) returning id`;
  await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values (${userId},'device.sample_registered','device',${device.id},${{ app, sample: true, binding: "proof_required" }})`;
}
