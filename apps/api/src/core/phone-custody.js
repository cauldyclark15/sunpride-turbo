import { forbidden } from "./errors.js";

/** Serialize office custody changes with sign-in, before a new session can be issued.
 * @param {any} db @param {string} keyId */
export async function lockPhoneKey(db, keyId) {
  await db`select pg_advisory_xact_lock(hashtextextended(${"phone-custody:" + keyId},0))`;
}

/** A lost key cannot sign in under another account/app or self-register, including sample/owner accounts.
 * @param {any} db @param {string} userId @param {string} app @param {string} keyId */
export async function requirePhoneCustody(db, userId, app, keyId) {
  const [phone] =
    await db`select c.state,d.app,p.user_id from company_phone_custody c
    join registered_devices d on d.id=c.device_id left join profiles p on p.id=d.profile_id
    where c.key_id=${keyId}`;
  if (!phone) return;
  if (phone.state === "lost")
    throw forbidden(
      "This phone was marked as lost. Only an administrator can register it again.",
      "device_revoked",
    );
  if (phone.user_id !== userId || phone.app !== app)
    throw forbidden(
      "This phone is assigned to another person. Ask the office to check Setup > Phones.",
      "device_unavailable",
    );
}
