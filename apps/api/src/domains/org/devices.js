import { requireCapability } from "../../core/capabilities.js";
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
