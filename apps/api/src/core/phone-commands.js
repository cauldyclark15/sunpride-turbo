import { tx } from "@sunpride/db/client";
import { readBearer } from "./context.js";
import { invalid, unauthenticated } from "./errors.js";
import { isUuid, sha256Hex } from "./util.js";
import { phoneHardware } from "./phone-hardware.js";

export const PHONE_ACTIONS = ["sign_out", "refresh", "resend", "remove", "update"];
/** Caller owns the transaction. Terminal commands end access immediately, not when the phone comes online.
 * @param {any} db @param {any} phone @param {string} kind @param {string} subject */
export async function queuePhoneCommand(db, phone, kind, subject) {
  const [command] = await db`insert into phone_commands(profile_id,device_id,app,key_id,kind,requested_by,download_url)
    values(${phone.profile_id},${phone.device_id ?? phone.id ?? null},${phone.app},${phone.key_id},${kind},${subject},${phone.download_url ?? null}) returning *`;
  if (["sign_out", "remove"].includes(kind)) {
    // Lock the sessions before revoking. A later password sign-in must not consume an old sign-out.
    const sessions = await db`select s.id from sessions s join profiles p on p.user_id=s.user_id
      where p.id=${phone.profile_id} and s.app=${phone.app} and s.device_key_id=${phone.key_id}
      and s.revoked_at is null and s.expires_at>now() for update of s`;
    for (const s of sessions) {
      await db`insert into phone_command_sessions(command_id,session_id) values(${command.id},${s.id})`;
      await db`update sessions set revoked_at=now() where id=${s.id}`;
    }
    if (kind === "remove" && (phone.device_id ?? phone.id))
      await db`update registered_devices set status='revoked' where id=${phone.device_id ?? phone.id}`;
  }
  await db`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values(${subject},${`device.phone_${kind}`},'device',${phone.device_id ?? phone.id ?? phone.profile_id},${JSON.stringify({ commandId: command.id })})`;
  return command;
}

/** Session-only control channel: an ended session can ONLY collect/ack its terminal command.
 * It never grants business access or issues a new access token. Waiting and removed phones need this too.
 * @param {import('./router.js').Router} router */
export function installPhoneChecks(router) {
  router.post("/api/auth/phone-check", async (c) => {
    const b = c.body;
    if (b?.version !== 2 || !["field-android", "van-android", "field-ios"].includes(b.app) ||
      typeof b.keyId !== "string" || !/^[a-f0-9]{64}$/.test(b.keyId) ||
      !Number.isInteger(b.unsentCount) || b.unsentCount < 0 || b.unsentCount > 1000000 ||
      !Array.isArray(b.acks) || b.acks.length > 20 || b.acks.some((/** @type {any} */ id) => !isUuid(id)))
      throw invalid("Invalid phone check");
    const token = readBearer(c.req);
    if (!token?.startsWith("sps_")) throw unauthenticated();
    return tx(c.db, async (t) => {
      const [s] = await t`select s.*,p.id as profile_id from sessions s join profiles p on p.user_id=s.user_id
        join users u on u.id=s.user_id where s.token_hash=${sha256Hex(token)} and s.app=${b.app}
        and s.device_key_id=${b.keyId} and s.expires_at>now() and u.disabled_at is null and p.deleted_at is null for update of s`;
      if (!s) throw unauthenticated();
      // A revoked credential has no general heartbeat authority. Only terminal requests explicitly assigned to it.
      const eligible = (/** @type {any} */ db) => db`((${s.revoked_at}::timestamptz is null and pc.kind not in ('sign_out','remove')) or
        exists(select 1 from phone_command_sessions pcs where pcs.command_id=pc.id and pcs.session_id=${s.id}))`;
      const commands = await t`select pc.* from phone_commands pc where pc.profile_id=${s.profile_id}
        and pc.app=${s.app} and pc.key_id=${s.device_key_id} and ${eligible(t)}
        and (pc.completed_at is null or pc.id in ${t(b.acks.length ? b.acks : [null])})
        order by (pc.kind in ('sign_out','remove')) desc,pc.created_at,pc.id limit 40 for update`;
      if (s.revoked_at && !commands.some((/** @type {any} */ pc) => ["sign_out", "remove"].includes(pc.kind)))
        throw unauthenticated();
      for (const id of b.acks) {
        const pc = commands.find((/** @type {any} */ row) => row.id === id);
        if (!pc || !pc.delivered_at) throw invalid("This request was not sent to this phone");
        if (!pc.completed_at) {
          await t`update phone_commands set completed_at=now() where id=${id}`;
          await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
            values(${s.user_id},'device.phone_command_done','device',${pc.device_id ?? pc.profile_id},${JSON.stringify({ commandId: id, kind: pc.kind })})`;
        }
      }
      const { manufacturer, model } = phoneHardware(c.req.headers);
      const version = typeof b.appVersion === "string" && /^[0-9A-Za-z._+() -]{1,80}$/.test(b.appVersion) ? b.appVersion : null;
      await t`insert into phone_checkins(profile_id,app,key_id,unsent_count,app_version,model)
        values(${s.profile_id},${s.app},${s.device_key_id},${b.unsentCount},${version},${[manufacturer, model].filter(Boolean).join(" ") || null})
        on conflict(profile_id,app,key_id) do update set checked_at=now(),unsent_count=excluded.unsent_count,
          app_version=coalesce(excluded.app_version,phone_checkins.app_version),model=coalesce(excluded.model,phone_checkins.model)`;
      await t`update registered_devices set last_seen_at=now() where profile_id=${s.profile_id} and app=${s.app} and key_id=${s.device_key_id}`;
      const pending = commands.filter((/** @type {any} */ pc) => !pc.completed_at && !b.acks.includes(pc.id)).slice(0, 20);
      for (const pc of pending) await t`update phone_commands set delivered_at=coalesce(delivered_at,now()) where id=${pc.id}`;
      return { version: 2, serverTime: Date.now(), commands: pending.map((/** @type {any} */ pc) => ({ id: pc.id, kind: pc.kind, ...(pc.download_url ? { downloadUrl: pc.download_url } : {}) })) };
    });
  }, { v2: true });
}
