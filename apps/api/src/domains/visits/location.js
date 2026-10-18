import { invalid, conflict, forbidden } from "../../core/errors.js";
import {
  ORGANIZATION,
  uuid,
  event,
  accessVisit,
  ms,
  changed,
} from "./shared.js";
import { requireCapability } from "../../core/capabilities.js";

/** @param {any} a @param {any} b */
export function haversine(a, b) {
  const rad = Math.PI / 180,
    dLat = (b.latitude - a.latitude) * rad,
    dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
/** @param {any} ctx @param {any} visit @param {string} kind @param {any} fix @param {number} deviceTime */
export async function recordLocation(ctx, visit, kind, fix, deviceTime) {
  if (
    fix !== null &&
    (!fix ||
      typeof fix !== "object" ||
      !Number.isFinite(fix.latitude) ||
      Math.abs(fix.latitude) > 90 ||
      !Number.isFinite(fix.longitude) ||
      Math.abs(fix.longitude) > 180 ||
      !Number.isFinite(fix.accuracyMeters) ||
      fix.accuracyMeters < 0 ||
      !Number.isSafeInteger(fix.fixTime) ||
      fix.fixTime < 0 ||
      !["gps", "network", "fused", "unknown"].includes(fix.provider) ||
      (fix.mockSignal != null && typeof fix.mockSignal !== "boolean"))
  )
    throw invalid("Invalid location evidence");
  const pins =
    await ctx.db`select * from outlet_pins where outlet_id=${visit.outlet_id} and status='verified' and deleted_at is null
    and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`;
  const pin =
    pins.length === 1 &&
    pins[0].radius_meters > 0 &&
    pins[0].radius_meters <= 500
      ? pins[0]
      : null;
  const distance = fix && pin ? haversine(fix, pin) : null;
  const unreliable =
    fix &&
    (fix.mockSignal === true ||
      fix.provider === "unknown" ||
      fix.accuracyMeters > 50 ||
      fix.fixTime > ctx.now + 120000 ||
      Math.abs(deviceTime - fix.fixTime) > 60000);
  const result =
    !fix || !pin
      ? "unavailable"
      : unreliable
        ? "unreliable"
        : Number(distance) > pin.radius_meters
          ? "outside_radius"
          : "within_radius";
  const [row] =
    await ctx.db`insert into visit_location_evidence (organization_id,org_unit_id,visit_id,event,latitude,longitude,provider,accuracy_meters,mock_signal,
    pin_id,pin_version,policy_version,radius_meters,distance_meters,result,review_status,device_time,server_time,fix_time,raw_location)
    values (${ORGANIZATION},${visit.org_unit_id},${visit.id},${kind},${fix?.latitude ?? null},${fix?.longitude ?? null},${fix?.provider ?? "unknown"},${fix?.accuracyMeters ?? null},${fix?.mockSignal ?? null},
      ${pin?.id ?? null},${pin ? `${pin.id}:${ms(pin.effective_from)}` : null},'field-day-2026-10-v3',${pin?.radius_meters ?? null},${distance},${result},
      ${result === "within_radius" ? "verified" : "pending_review"},${new Date(deviceTime)},${new Date(ctx.now)},${fix ? new Date(fix.fixTime) : null},${fix}) returning id`;
  return row.id;
}
/** Append a separately authored decision, never patch the raw fix. @param {any} ctx */
export async function decideLocation(ctx) {
  const p = ctx.body;
  if (
    !["approve", "reject"].includes(p.decision) ||
    typeof p.reason !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,80}$/.test(p.reason)
  )
    throw invalid();
  const [fix] =
    await ctx.db`select * from visit_location_evidence where id=${uuid(p.evidenceId)} for update`;
  if (!fix) throw forbidden("Evidence unavailable", "out_of_scope");
  const [visit] =
    await ctx.db`select * from visit_executions where id=${fix.visit_id}`;
  await accessVisit(ctx, visit);
  await requireCapability(
    ctx,
    "visit.locationException.approve",
    visit.org_unit_id,
  );
  if (visit.assignee_profile_id === ctx.actor.profileId)
    throw forbidden("You cannot decide your own visit", "self_approval_denied");
  const prior =
    await ctx.db`select 1 from execution_events where entity_id=${fix.id} and kind='location.exception.decided'`;
  if (fix.review_status !== "pending_review" || prior.length)
    throw conflict("Already reviewed", "already_reviewed");
  const reviewStatus =
    p.decision === "approve" ? "approved_exception" : "rejected";
  const eventId = await event(
    ctx,
    visit,
    "visit",
    fix.id,
    "location.exception.decided",
    { after: reviewStatus, reasonCode: p.reason },
  );
  await changed(ctx, visit);
  return { reviewStatus, eventId };
}
