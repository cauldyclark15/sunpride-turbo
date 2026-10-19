import { requireCapability } from "../../core/capabilities.js";
import { ApiError, invalid } from "../../core/errors.js";
import {
  accessVisit,
  employeeAt,
  date,
  uuid,
  ms,
  dayClose,
  manilaDate,
  ORGANIZATION,
} from "./shared.js";
import { dto } from "./reads.js";

/** Supervisor's current-scope, bounded day trail. @param {any} ctx */
export async function trace(ctx) {
  const personId = uuid(
    ctx.url.searchParams.get("personId") ??
      ctx.url.searchParams.get("profileId"),
  );
  const serviceDate = date(
    ctx.url.searchParams.get("date") ??
      ctx.url.searchParams.get("serviceDate") ??
      manilaDate(ctx.now),
  );
  const person = await employeeAt(ctx.db, personId, ctx.now);
  await requireCapability(
    ctx,
    "visit.locationException.approve",
    person.org_unit_id,
  );
  const visits =
    await ctx.db`select v.*,o.name as outlet_name from visit_executions v join outlets o on o.id=v.outlet_id
    where v.organization_id=${ORGANIZATION} and v.assignee_profile_id=${personId} and v.service_date=${serviceDate} and v.deleted_at is null order by v.id limit 201`;
  if (visits.length > 200) throw invalid("Day visit limit exceeded");
  const points = [];
  for (const visit of visits) {
    try {
      await accessVisit(ctx, visit);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) continue;
      throw e;
    }
    const fixes =
      await ctx.db`select f.*,e.summary_after as decided_status from visit_location_evidence f left join execution_events e
      on e.entity_id=f.id::text and e.kind='location.exception.decided' where f.visit_id=${visit.id} order by f.device_time,f.id`;
    for (const f of fixes)
      points.push({
        id: f.id,
        visitId: visit.id,
        outletId: visit.outlet_id,
        outletName: visit.outlet_name,
        plannedVisitId: visit.planned_visit_id,
        event: f.event,
        deviceTime: ms(f.device_time),
        serverTime: ms(f.server_time),
        latitude: f.latitude,
        longitude: f.longitude,
        accuracyMeters: f.accuracy_meters,
        provider: f.provider,
        mockSignal: f.mock_signal === true,
        distanceMeters: f.distance_meters,
        radiusMeters: f.radius_meters,
        result: f.result,
        reviewStatus: f.decided_status ?? f.review_status,
        late: ms(f.server_time) > dayClose(serviceDate),
      });
  }
  points.sort(
    (a, b) => a.deviceTime - b.deviceTime || a.serverTime - b.serverTime,
  );
  return { serviceDate, closeAt: dayClose(serviceDate), points };
}
/** @param {any} ctx */
export async function lateQueue(ctx) {
  const unitId = uuid(ctx.url.searchParams.get("unitId"));
  await requireCapability(ctx, "visit.locationException.approve", unitId);
  const cursor = ctx.url.searchParams.get("cursor");
  if (cursor) uuid(cursor);
  const limit = Number(ctx.url.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const rows =
    await ctx.db`select v.*,p.name as person_name,o.name as outlet_name from visit_executions v join profiles p on p.id=v.assignee_profile_id join outlets o on o.id=v.outlet_id
    where v.organization_id=${ORGANIZATION} and v.org_unit_id=${unitId} and v.late_review_status='pending_review' and v.deleted_at is null
    and (${cursor}::uuid is null or v.id>${cursor}::uuid) order by v.id limit ${limit + 1}`;
  const visible = [];
  for (const visit of rows.slice(0, limit)) {
    try {
      await accessVisit(ctx, visit);
      visible.push(dto(visit));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) continue;
      throw e;
    }
  }
  return {
    rows: visible,
    next: rows.length > limit ? rows[limit - 1].id : null,
  };
}
