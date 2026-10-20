import { requireCapability, roleHas } from "../../core/capabilities.js";
import { forbidden } from "../../core/errors.js";
import { currentActor, currentDeviceActor } from "../van/access.js";
import { uuid, refuse, integer, today, dayString } from "../van/model.js";

/** F-R01: always reload persisted mode; proof-time authority is not a durable grant.
 * @param {any} db @param {string} deviceId @param {number} [at] */
export async function modeAt(db, deviceId, at = Date.now()) {
  const rows =
    await db`select * from pos_device_modes where device_id=${uuid(deviceId)} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  if (rows.length > 1) refuse("Conflicting POS modes need office review");
  return rows[0] ?? null;
}
/** F-R01. @param {any} db @param {any} actor @param {string} registerId @param {string} [capability] */
export async function registerFor(
  db,
  actor,
  registerId,
  capability = "van.read",
) {
  const [r] =
    await db`select r.*,l.name as store_name,l.org_unit_id,l.organization_id,l.active,l.deleted_at,l.type from store_registers r join inventory_locations l on l.id=r.location_id where r.id=${uuid(registerId)} for update of r for share of l`;
  if (!r || !r.active || r.deleted_at || r.type !== "store")
    throw forbidden("Store register is unavailable", "out_of_scope");
  await requireCapability({ db, actor }, capability, r.org_unit_id);
  return r;
}
/** F-R01. @param {any} db @param {any} actor @param {any} device @param {number} at */
export async function cashierContext(db, actor, device, at) {
  const fresh = await currentDeviceActor(db, actor, device.id);
  const mode = await modeAt(db, device.id);
  if (mode?.mode !== "store") refuse("This handheld is not in Store mode");
  const r = await registerFor(db, fresh.actor, mode.register_id, "van.operate");
  if (r.org_unit_id !== fresh.device.org_unit_id)
    throw forbidden("Register and handheld must share their assigned unit");
  if (
    +new Date(r.effective_from) > at ||
    (r.effective_to && +new Date(r.effective_to) <= at)
  )
    refuse("Register was not effective at capture time");
  const assignments =
    await db`select id from store_cashier_assignments where register_id=${r.id} and profile_id=${fresh.actor.profileId} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) for share`;
  const currentAssignments =
    await db`select id from store_cashier_assignments where register_id=${r.id} and profile_id=${fresh.actor.profileId} and effective_from<=now() and (effective_to is null or effective_to>now()) for share`;
  if (assignments.length !== 1 || currentAssignments.length !== 1)
    throw forbidden(
      "You are not assigned as a cashier at this register",
      "out_of_scope",
    );
  return { ...fresh, register: r, mode };
}
/** F-R01. @param {any} c */
export function captureTime(c) {
  const at = c.payload.deviceTime;
  if (
    !Number.isSafeInteger(at) ||
    at !== c.op.clientTime ||
    at > c.now + 60000 ||
    at < c.now - 7 * 86400000
  )
    refuse(
      "Capture time is outside the supported offline window",
      "wrong_date",
    );
  return Number(at);
}
/** F-R01: configuration rides the existing authorized van bundle, even with no trip.
 * @param {any} db @param {any} actor @param {any} device @param {any} mode */
export async function modeBundle(db, actor, device, mode) {
  if (!mode) return null;
  const r = mode.register_id
    ? await registerFor(db, actor, mode.register_id)
    : null;
  const [policy] = r
    ? await db`select id,tolerance_centavos from store_register_policies where register_id=${r.id} and effective_from<=now() and (effective_to is null or effective_to>now())`
    : [];
  const [open] =
    await db`select s.id,s.opened_at,s.service_date,s.mode_version_id,s.policy_id from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.device_id=${device.id} and s.cashier_id=${actor.profileId} and c.id is null`;
  return {
    version: 1,
    mode: mode.mode,
    modeVersionId: mode.id,
    registerId: r?.id ?? null,
    registerName: r?.name ?? null,
    storeName: r?.store_name ?? null,
    terminalCode: r?.terminal_code ?? null,
    policyId: policy?.id ?? null,
    toleranceCentavos: policy ? String(policy.tolerance_centavos) : null,
    allowLocalSwitch: false,
    // SEAM(ORDERS): no pretend trip, local price list or parallel commercial ledger.
    transactionsEnabled: false,
    shift: open
      ? {
          shiftId: open.id,
          openedAt: +new Date(open.opened_at),
          serviceDate: dayString(open.service_date),
          modeVersionId: open.mode_version_id,
          policyId: open.policy_id,
        }
      : null,
  };
}
/** F-R01 server-owned money validation. @param {any} value */
export const money = (value) => String(integer(value));
/** F-R01: only independent cash approvers see expected/variance after submission.
 * @param {any} db @param {any} actor @param {any} s */
export async function shiftView(db, actor, s) {
  const canReview =
    roleHas(actor.role, "van.cash.approve") && actor.profileId !== s.cashier_id;
  return {
    id: s.id,
    registerId: s.register_id,
    registerName: s.register_name,
    storeName: s.store_name,
    cashierName: s.cashier_name,
    serviceDate: dayString(s.service_date),
    openedAt: +new Date(s.opened_at),
    closedAt: s.closed_at ? +new Date(s.closed_at) : null,
    status: s.closed_at
      ? (s.decision ?? (s.needs_review ? "needs_review" : "closed"))
      : "open",
    declaredCentavos: s.closed_at ? String(s.declared_centavos) : null,
    expectedCentavos:
      canReview && s.closed_at ? String(s.expected_centavos) : null,
    varianceCentavos:
      canReview && s.closed_at ? String(s.variance_centavos) : null,
    closureId: canReview ? (s.closure_id ?? null) : null,
    canDecide: Boolean(canReview && s.needs_review && !s.decision),
  };
}
export { currentActor, today };
