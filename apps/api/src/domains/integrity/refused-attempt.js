import { reauthorizeDevice } from "../../core/devices.js";
import { requireCapability } from "../../core/capabilities.js";
import { forbidden, invalid } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";
import { outletOwnerUnit } from "../org/scope.js";
import { currentActor } from "../van/access.js";

/** F-221: telemetry only. A locally refused attempt must NEVER create a visit or satisfy call flow.
 * @param {any} c */
export async function refusedCheckIn(c) {
  const actor = await currentActor(c.db, c.actor);
  const { device } = await reauthorizeDevice(c.db, actor, c.device.id);
  if (device.app !== "field-android") throw forbidden();
  const p = c.payload;
  if (
    p.mockSignal !== true ||
    !isUuid(p.outletId) ||
    !Number.isSafeInteger(p.deviceTime) ||
    Math.abs(p.deviceTime - Date.now()) > 7 * 86400_000
  )
    throw invalid("Invalid refused attempt");
  await requireCapability({ ...c, actor }, "visit.record", actor.orgUnitId);
  const unit = await outletOwnerUnit(c.db, p.outletId, Date.now());
  if (!unit || unit !== actor.orgUnitId) throw forbidden();
  const [r] =
    await c.db`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,device_id,outlet_id,occurred_at,facts)
    values(${`phone-refusal:${device.id}:${c.op.clientOpId}`},'refused_check_in',${actor.profileId},${unit},${device.id},${p.outletId},${new Date(p.deviceTime)},${{ mockSignal: true, refusedOnPhone: true, receivedAt: Date.now() }}) returning id`;
  c.publish("integrity");
  return { entityId: r.id, eventIds: [] };
}
