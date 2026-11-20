import { lockPhoneKey } from "../../core/phone-custody.js";
import { access } from "./readers.js";
import { personAt } from "./scope.js";
import { rule, uuid } from "./model.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */

/** Lock in the same order as native sign-in; commands already hold the org lock.
 * @param {Ctx} c @param {Row} b */
async function phone(c, b) {
  const found = await access(c, "devices", uuid(b.deviceId), "admin.manage");
  await lockPhoneKey(c.db, found.key_id);
  await c.db`select id from registered_devices where id=${found.id} for update`;
  return access(c, "devices", found.id, "admin.manage");
}

/** End every session for this physical key, including old/unregistered users and other apps.
 * Never removes received operations or unsent-work recovery records.
 * @param {Ctx} c @param {string} keyId */
async function endSessions(c, keyId) {
  await c.db`update sessions set revoked_at=now() where device_key_id=${keyId} and revoked_at is null`;
  await c.db`delete from access_tokens where session_id in (select id from sessions where device_key_id=${keyId})`;
  await c.db`update device_challenges set consumed_at=now() where device_id in (select id from registered_devices where key_id=${keyId}) and consumed_at is null`;
  await c.db`update van_crew_sessions set ended_at=now(),ended_reason='office phone custody changed'
    where device_id in (select id from registered_devices where key_id=${keyId}) and ended_at is null`;
  await c.db`update van_device_bindings set released_at=now(),released_by=${c.actor?.subject ?? "system"}
    where device_id in (select id from registered_devices where key_id=${keyId}) and released_at is null`;
}

/** @param {Ctx} c @param {Row} d @param {'assigned'|'lost'} state */
async function custody(c, d, state) {
  await c.db`insert into company_phone_custody(key_id,device_id,state) values(${d.key_id},${d.id},${state})
    on conflict(key_id) do update set device_id=excluded.device_id,state=excluded.state,changed_at=now()`;
}

/** @param {Ctx} c @param {Row} d */
async function ready(c, d) {
  if (
    (
      await c.db`select 1 from device_controls where device_id=${d.id} and status='pending' limit 1`
    ).length
  )
    rule("Finish this phone’s pending recovery or handover first");
  if (
    (
      await c.db`select 1 from registered_devices where key_id=${d.key_id} and id<>${d.id} and status<>'revoked' limit 1`
    ).length
  )
    rule(
      "This phone has another registration. Reconcile it before assigning it",
    );
}

/** Same handset, new person. The new person must sign in and prove possession again before downloading their data.
 * @param {Ctx} c @param {Row} b */
export async function reassignPhone(c, b) {
  const d = await phone(c, b);
  const person = await personAt(
    c.db,
    await access(c, "people", uuid(b.profileId), "admin.manage"),
    c.now,
  );
  if (d.status === "revoked")
    rule("Register this phone again before giving it to another person");
  if (d.profile_id === person.id) rule("Choose a different person");
  if (person.status !== "active" || !person.org_unit_id || !person.user_id)
    rule("Choose an active person with a branch and a sign-in account");
  const multiplePhones =
    person.role === "super_admin" || person.phone_auto_approve === true;
  await ready(c, d);
  if (
    !multiplePhones &&
    (
      await c.db`select 1 from registered_devices where profile_id=${person.id} and status<>'revoked' and id<>${d.id} limit 1`
    ).length
  )
    rule(
      "The replacement person already has a phone. Reconcile that phone first",
    );
  await endSessions(c, d.key_id);
  await c.db`update registered_devices set profile_id=${person.id},org_unit_id=${person.org_unit_id},status='active',
    bound_subject=null,credential_id=null,bound_at=null,attestation=null,superadmin_auto=${multiplePhones} where id=${d.id}`;
  await custody(c, d, "assigned");
  await c.db`update phone_registration_requests set status='superseded',decided_at=now(),decided_by=${c.actor?.subject ?? "system"}
    where key_id=${d.key_id} and status='waiting'`;
  return null;
}

/** Lost is distinct from a recoverable pause: no account or recovery sign-in may use this key.
 * @param {Ctx} c @param {Row} b */
export async function losePhone(c, b) {
  const d = await phone(c, b);
  const rows =
    await c.db`select id from registered_devices where key_id=${d.key_id} order by id for update`;
  for (const row of rows) await access(c, "devices", row.id, "admin.manage");
  await endSessions(c, d.key_id);
  await c.db`update registered_devices set status='revoked' where key_id=${d.key_id}`;
  await custody(c, d, "lost");
  return null;
}

/** Only an authorized office administrator can restore a lost handset. Old sessions/bindings stay invalid.
 * @param {Ctx} c @param {Row} b */
export async function reregisterPhone(c, b) {
  const d = await phone(c, b);
  const [lost] =
    await c.db`select 1 from company_phone_custody where key_id=${d.key_id} and device_id=${d.id} and state='lost'`;
  if (!lost) rule("Only a phone marked as lost can be registered again here");
  const person = await personAt(
    c.db,
    await access(
      c,
      "people",
      uuid(b.profileId ?? d.profile_id),
      "admin.manage",
    ),
    c.now,
  );
  if (person.status !== "active" || !person.org_unit_id || !person.user_id)
    rule("The assigned person must have an active account and branch");
  const multiplePhones =
    person.role === "super_admin" || person.phone_auto_approve === true;
  await ready(c, d);
  if (
    !multiplePhones &&
    (
      await c.db`select 1 from registered_devices where profile_id=${person.id} and id<>${d.id} and status<>'revoked' limit 1`
    ).length
  )
    rule("This person already has another phone. Reconcile it first");
  await endSessions(c, d.key_id);
  await c.db`update registered_devices set status='active',profile_id=${person.id},org_unit_id=${person.org_unit_id},
    bound_subject=null,credential_id=null,bound_at=null,attestation=null,superadmin_auto=${multiplePhones} where id=${d.id}`;
  await custody(c, d, "assigned");
  return null;
}
