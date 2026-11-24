import { requireCapability } from "../../core/capabilities.js";
import { reauthorizeDevice } from "../../core/devices.js";
import { OpRejected } from "../../core/sync.js";
import { currentActor } from "../van/access.js";
import { access } from "../org/readers.js";
import { integer, rule, uuid } from "../org/model.js";

/** Close only the current pin interval; never rewrite historical coordinates.
 * @param {any} c @param {string} outletId @param {any} point @param {any} actor */
export async function setOfficePin(c, outletId, point, actor) {
  const rows =
    await c.db`select * from outlet_pins where outlet_id=${outletId} and status='verified' and deleted_at is null for update`;
  const from = Math.max(
    c.now,
    ...rows
      .filter((/** @type {any} */ r) => +r.effective_from <= c.now)
      .map((/** @type {any} */ r) => +r.effective_from + 1),
  );
  if (rows.some((/** @type {any} */ r) => +r.effective_from > c.now))
    rule("A future store pin is already scheduled.");
  await c.db`update outlet_pins set effective_to=${new Date(from)} where outlet_id=${outletId} and status='verified' and deleted_at is null and effective_from<${new Date(from)} and (effective_to is null or effective_to>${new Date(from)})`;
  const [pin] =
    await c.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at,reviewer_reason) values(${outletId},${point.latitude},${point.longitude},75,'office','verified',${new Date(from)},${actor.subject},${new Date(c.now)},${actor.subject},${new Date(c.now)},'Location set on the map by the office') returning id`;
  await c.db`update outlet_pins set status='rejected',reviewer_reason='Replaced by the office map correction',verified_by=${actor.subject},verified_at=${new Date(c.now)} where outlet_id=${outletId} and status='pending' and deleted_at is null`;
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'SP-0251.location.office','outlet',${outletId},'Store location set on the map')`;
  return { id: pin.id, outletId };
}
/** @param {any} p */
function point(p) {
  if (
    !Number.isFinite(p.latitude) ||
    Math.abs(p.latitude) > 90 ||
    !Number.isFinite(p.longitude) ||
    Math.abs(p.longitude) > 180
  )
    rule("Set the store location on the map.");
}
/** @param {any} c @param {any} p */
export async function officeLocation(c, p) {
  const actor = await requireCapability(c, "outlet.verify");
  const outlet = await access(c, "outlets", uuid(p.outletId), "outlet.verify");
  if (outlet.status === "inactive" || outlet.deleted_at)
    rule("This store is closed.");
  point(p);
  return setOfficePin(c, outlet.id, p, actor);
}
/** Resolve ownership and current scope before a replay receipt is returned.
 * @param {any} c @param {any} p */
export async function locationTarget(c, p) {
  const actor = await requireCapability(c, "outlet.enrol.propose");
  let outletId = p.outletId ? uuid(p.outletId) : null;
  const captureId = p.captureId ? uuid(p.captureId) : null;
  if (Boolean(outletId) === Boolean(captureId)) rule("Choose one store.");
  if (captureId) {
    const [enrolment] =
      await c.db`select outlet_id from outlet_enrolments where client_request_id=${captureId} and proposed_by=${actor.subject}`;
    if (enrolment) outletId = enrolment.outlet_id;
    else {
      const [capture] =
        await c.db`select c.id,b.org_unit_id,r.outlet_id,r.decision from census_captures c join census_batches b on b.id=c.batch_id left join census_reviews r on r.capture_id=c.id where c.id=${captureId} and c.actor_profile_id=${actor.profileId} and c.kind='new'`;
      if (!capture) rule("Saved store not found.");
      await requireCapability(c, "outlet.enrol.propose", capture.org_unit_id);
      if (capture.decision && capture.decision !== "accept")
        rule("The office did not accept this store.");
      outletId = capture.outlet_id;
    }
  }
  if (outletId) {
    const outlet = await access(c, "outlets", outletId, "outlet.enrol.propose");
    if (outlet.status === "inactive" || outlet.deleted_at)
      rule("This store is closed.");
  }
  return { outletId, captureId };
}

/** Signed follow-up op, independent of the original immutable save. It may wait offline.
 * @param {any} c @param {any} p */
export async function tagLocation(c, p) {
  if (c.app !== "field-android") throw new OpRejected("unsupported_operation");
  const fresh = await currentActor(c.db, c.actor);
  const checked = await reauthorizeDevice(c.db, fresh, c.device.id);
  if (checked.device.app !== c.app)
    throw new OpRejected("unsupported_operation");
  c = { ...c, actor: fresh };
  const actor = await requireCapability(c, "outlet.enrol.propose");
  // Serialize with office pin changes and all follow-up operations.
  await c.db`select pg_advisory_xact_lock(4310420)`;
  const at = integer(p.deviceTime, c.now - 7 * 86400000, c.now + 120000);
  const l = p.location;
  if (!l || typeof l !== "object") rule("Try Tag location now again.");
  point(l);
  if (
    !Number.isFinite(l.accuracyMeters) ||
    l.accuracyMeters <= 0 ||
    l.accuracyMeters > 500 ||
    l.mockSignal !== false ||
    l.provider !== "gps" ||
    !Number.isSafeInteger(l.fixTime) ||
    Math.abs(at - l.fixTime) > 120000
  )
    rule("Use a fresh phone GPS reading.");
  const { outletId, captureId } = await locationTarget(c, p);
  if (outletId) {
    // Field evidence never silently moves a pin the office has confirmed.
    const [verified] =
      await c.db`select id from outlet_pins where outlet_id=${outletId} and status='verified' and deleted_at is null and (effective_to is null or effective_to>now()) limit 1`;
    if (verified) return { entityId: outletId, eventIds: [] };
  }
  const [tag] =
    await c.db`insert into store_location_tags(capture_id,outlet_id,actor_profile_id,latitude,longitude,accuracy_meters,recorded_at) values(${captureId},${outletId},${actor.profileId},${l.latitude},${l.longitude},${l.accuracyMeters},${new Date(l.fixTime)}) returning id`;
  if (outletId) {
    const [best] =
      await c.db`select id,accuracy_meters from store_location_tags where outlet_id=${outletId} order by accuracy_meters,recorded_at desc limit 1`;
    if (best.id === tag.id) {
      const [enrolment] =
        await c.db`select location_evidence from outlet_enrolments where outlet_id=${outletId} and status='pending' order by proposed_at desc limit 1`;
      const original = enrolment?.location_evidence;
      if (original && original.accuracyMeters <= l.accuracyMeters)
        return { entityId: outletId, eventIds: [] };
      await c.db`update outlet_pins set status='rejected',reviewer_reason='Replaced by a better phone reading' where outlet_id=${outletId} and status='pending' and source in ('field-gps','new_store_enrolment') and deleted_at is null`;
      const [pin] =
        await c.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,evidence_note) values(${outletId},${l.latitude},${l.longitude},75,'field-gps','pending',${new Date(c.now)},${actor.subject},${new Date(c.now)},${`Phone GPS accuracy ${l.accuracyMeters} m`}) returning id`;
      await c.db`update outlet_enrolments set pin_id=${pin.id} where outlet_id=${outletId} and status='pending'`;
    }
  }
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'SP-0251.location.tag','outlet',${outletId ?? captureId},'Follow-up phone location received')`;
  c.publish("masters");
  c.publish("org");
  return { entityId: outletId ?? captureId, eventIds: [] };
}
