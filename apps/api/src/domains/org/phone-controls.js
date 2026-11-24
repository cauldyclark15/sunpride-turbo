import { PHONE_ACTIONS, queuePhoneCommand } from "../../core/phone-commands.js";
import { access } from "./readers.js";
import { uuid, rule } from "./model.js";
import { registerWaitingPhone } from "../integrity/waiting-phones.js";
import { phoneModelLabel } from "../../core/phone-hardware.js";

/** @param {any} c @param {any} p */
export async function phoneControls(c, p) {
  const person = await access(c, "people", uuid(p.profileId), "phones.manage");
  const phones = await c.db`select d.id,d.id as device_id,null::uuid as request_id,d.app,d.key_id,d.inventory_tag as label,
    d.manufacturer,d.model,d.app_version_name as app_version,case d.status when 'active' then 'registered' when 'revoked' then 'removed' else 'paused' end as status,d.last_seen_at
    from registered_devices d where d.profile_id=${person.id}
    union all select r.id,null::uuid,r.id,r.app,r.key_id,'Waiting phone',r.manufacturer,r.model,null::text,'waiting',r.last_seen_at
    from phone_registration_requests r where r.profile_id=${person.id} and r.status='waiting'
      and not exists(select 1 from registered_devices d where d.profile_id=r.profile_id and d.app=r.app and d.key_id=r.key_id)
    order by last_seen_at desc nulls last,id limit 101`;
  const result = [];
  for (const phone of phones.slice(0, 100)) {
    if (phone.device_id) await access(c, "devices", phone.device_id, "phones.manage");
    const [check] = await c.db`select * from phone_checkins where profile_id=${person.id} and app=${phone.app} and key_id=${phone.key_id}`;
    const [session] = await c.db`select 1 from sessions where user_id=${person.user_id} and app=${phone.app}
      and device_key_id=${phone.key_id} and revoked_at is null and expires_at>now() limit 1`;
    const history = await c.db`select pc.id,pc.kind,pc.created_at,pc.completed_at,p.name as who from phone_commands pc
      left join profiles p on p.auth_subject=pc.requested_by where pc.profile_id=${person.id} and pc.app=${phone.app} and pc.key_id=${phone.key_id}
      order by pc.created_at desc,pc.id desc limit 51`;
    result.push({ id: phone.id, deviceId: phone.device_id, requestId: phone.request_id, app: phone.app,
      label: phone.label, model: check?.model ?? phoneModelLabel(phone), appVersion: check?.app_version ?? phone.app_version ?? null,
      status: phone.status, signedIn: Boolean(session), unsentCount: check?.unsent_count ?? null,
      lastSeenAt: check?.checked_at ?? phone.last_seen_at ?? null,
      history: history.slice(0, 50).map((/** @type {any} */ r) => ({ id: r.id, kind: r.kind, who: r.who ?? "Former user", requestedAt: r.created_at, doneAt: r.completed_at })),
      historyMore: history.length > 50 });
  }
  return { person: { id: person.id, name: person.name, autoAccept: person.role === "super_admin" || person.phone_office_auto_accept },
    phones: result, more: phones.length > 100 };
}

/** The ordinary org command wrapper supplies transaction, reauthorization, idempotency and scope checks.
 * @param {any} c @param {any} b */
export async function phoneControlCommand(c, b) {
  const person = await access(c, "people", uuid(b.profileId), "phones.manage");
  if (b.action === "auto_accept") {
    if (typeof b.enabled !== "boolean") rule("Choose on or off");
    if (person.role === "super_admin" && !b.enabled) rule("The owner's new phones are always accepted");
    await c.db`update profiles set phone_office_auto_accept=${b.enabled} where id=${person.id}`;
    // Record against every phone as well as the person so its history identifies the office actor.
    await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details)
      select ${c.actor.subject},${b.enabled ? "device.auto_accept_on" : "device.auto_accept_off"},'device',id,'Office phone preference'
      from registered_devices where profile_id=${person.id}`;
    return { saved: true };
  }
  if (b.action === "register") {
    const [waiting] = await c.db`select profile_id from phone_registration_requests where id=${uuid(b.requestId)}`;
    if (waiting?.profile_id !== person.id) rule("Choose this person's waiting phone");
    return registerWaitingPhone({ ...c, body: { requestId: b.requestId } });
  }
  if (b.action === "sign_out_all") {
    const sessions = await c.db`select distinct app,device_key_id as key_id from sessions where user_id=${person.user_id}
      and app in ('field-android','van-android','field-ios') and device_key_id is not null and revoked_at is null and expires_at>now()`;
    for (const s of sessions) {
      const [d] = await c.db`select id from registered_devices where profile_id=${person.id} and app=${s.app} and key_id=${s.key_id} order by created_at desc limit 1`;
      if (d) await access(c, "devices", d.id, "phones.manage");
      await queuePhoneCommand(c.db, { ...s, profile_id: person.id, device_id: d?.id ?? null }, "sign_out", c.actor.subject);
    }
    return { count: sessions.length };
  }
  if (!PHONE_ACTIONS.includes(b.action)) rule("Choose a phone control");
  const device = await access(c, "devices", uuid(b.deviceId), "phones.manage");
  if (device.profile_id !== person.id) rule("Choose this person's phone");
  if (device.status === "revoked") rule("This phone is already removed");
  if (b.action === "update" && device.app === "field-ios") {
    let url;
    try { url = new URL(b.downloadUrl); } catch { rule("Enter the iPhone update download link"); }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || url.href.length > 1000)
      rule("Use a secure iPhone update download link without sign-in details");
    device.download_url = url.href;
  }
  const pc = await queuePhoneCommand(c.db, device, b.action, c.actor.subject);
  return { id: pc.id };
}
