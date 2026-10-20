import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { invalid, forbidden } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";
import { enqueue } from "../../core/jobs.js";
import { scopeFilterForActor } from "../org/scope.js";
import { dayFacts } from "./projections.js";
import {
  ORGANIZATION,
  ZERO_UUID,
  DAY_MS,
  closeAt,
  dateOf,
  distanceMeters,
  manilaDate,
  midnight,
  ms,
  personInScope,
  serviceDate,
  uuid,
  visiblePeople,
} from "./model.js";

export const LOCATION_POLICY = Object.freeze({
  retentionMs: 90 * DAY_MS,
  maxAgeMs: 7 * DAY_MS,
  maxFutureSkewMs: 300_000,
  minSpacingMs: 10_000,
  idleFlagMs: 45 * 60_000,
  maxTrailPings: 3000,
  maxStops: 500,
});
/** @param {any} p */
function validPing(p) {
  const range = (
    /** @type {any} */ n,
    /** @type {number} */ lo,
    /** @type {number} */ hi,
  ) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
  return (
    isUuid(p.clientPingId) &&
    Number.isSafeInteger(p.recordedAt) &&
    range(p.latitude, -90, 90) &&
    range(p.longitude, -180, 180) &&
    range(p.accuracyMeters, 0, 100_000) &&
    (p.speedMetersPerSecond === null ||
      range(p.speedMetersPerSecond, 0, 150)) &&
    (p.headingDegrees === null || range(p.headingDegrees, 0, 360)) &&
    (p.batteryPercent === null || range(p.batteryPercent, 0, 100)) &&
    typeof p.mockLocation === "boolean" &&
    ["gps", "network", "fused", "unknown"].includes(p.provider) &&
    ["start", "moving", "still", "stop"].includes(p.trigger) &&
    (p.visitId == null || isUuid(p.visitId)) &&
    (p.tripId == null || isUuid(p.tripId))
  );
}
/** @param {any} db @param {string} profileId */
async function personLock(db, profileId) {
  await db`select pg_advisory_xact_lock(hashtext(${`fieldsync:${profileId}`}))`;
}
/** One exact D5 ping; the core handles batches, proof, receipts and retry. @param {import('../../core/sync.js').OpCtx} ctx */
export async function recordLocation(ctx) {
  const p = /** @type {any} */ (ctx.payload);
  if (
    !validPing(p) ||
    p.clientPingId !== ctx.op.clientOpId ||
    p.recordedAt !== ctx.op.clientTime
  )
    ctx.reject("invalid_request");
  if (
    ctx.now - p.recordedAt > LOCATION_POLICY.maxAgeMs ||
    p.recordedAt > ctx.now + LOCATION_POLICY.maxFutureSkewMs
  )
    ctx.reject("wrong_date");
  const kind = ctx.app === "van-android" ? "van" : "field";
  await requireCapability(
    ctx,
    kind === "van" ? "van.operate" : "visit.record",
    ctx.actor.orgUnitId,
  );
  if (!ctx.actor.orgUnitId) ctx.reject("out_of_scope");
  const db = ctx.db;
  await personLock(db, ctx.actor.profileId);
  const [consent] =
    await db`select enabled from fieldsync_location_consents where profile_id=${ctx.actor.profileId}
    and effective_from<=${new Date(p.recordedAt)} order by effective_from desc,id desc limit 1`;
  if (!consent?.enabled) ctx.reject("invalid_transition");
  const date = manilaDate(p.recordedAt);
  const hour = new Date(p.recordedAt + 28_800_000).getUTCHours();
  if (hour < 5 || p.recordedAt >= closeAt(date))
    ctx.reject("invalid_transition");
  let unitId = ctx.actor.orgUnitId;
  let vehicleId = null;
  let tripId = null;
  let visitId = null;
  const [currentConsent] =
    await db`select enabled from fieldsync_location_consents where profile_id=${ctx.actor.profileId} and effective_from<=${new Date(ctx.now)} order by effective_from desc,id desc limit 1`;
  let trackingEnded =
    p.trigger === "stop" ||
    !currentConsent?.enabled ||
    date !== manilaDate(ctx.now) ||
    ctx.now >= closeAt(date);
  if (kind === "field") {
    if (p.tripId) ctx.reject("invalid_request");
    let [day] =
      await db`select * from fieldsync_work_days where profile_id=${ctx.actor.profileId} and service_date=${date}::date for update`;
    if (!day) {
      const [first] =
        await db`select min(checked_in_at) as at from visit_executions where assignee_profile_id=${ctx.actor.profileId}
        and service_date=${date}::date and deleted_at is null and org_unit_id=${unitId}`;
      if (!first?.at) ctx.reject("invalid_transition");
      await db`insert into fieldsync_work_days(profile_id,service_date,started_at) values (${ctx.actor.profileId},${date},${first.at})
        on conflict(profile_id,service_date) do nothing`;
      [day] =
        await db`select * from fieldsync_work_days where profile_id=${ctx.actor.profileId} and service_date=${date}::date for update`;
    }
    if (p.recordedAt < (ms(day.started_at) ?? 0))
      ctx.reject("invalid_transition");
    if (day.ended_at && p.recordedAt > (ms(day.ended_at) ?? 0))
      ctx.reject("invalid_transition");
    trackingEnded ||=
      day.ended_at !== null && (ms(day.ended_at) ?? 0) <= ctx.now;
    if (p.visitId) {
      const [v] =
        await db`select id from visit_executions where id=${p.visitId} and assignee_profile_id=${ctx.actor.profileId}
        and org_unit_id=${unitId} and service_date=${date}::date and deleted_at is null`;
      if (!v) ctx.reject("out_of_scope");
      visitId = v.id;
    }
    if (p.trigger === "stop")
      await db`update fieldsync_work_days set ended_at=${new Date(p.recordedAt)},end_reason='end_day'
      where id=${day.id} and (ended_at is null or ended_at>${new Date(p.recordedAt)})`;
  } else {
    if (!p.tripId || p.visitId) ctx.reject("invalid_request");
    const [trip] =
      await db`select * from van_trips where id=${p.tripId} and salesperson_profile_id=${ctx.actor.profileId}
      and started_device_id=${ctx.device.id} and deleted_at is null for share`;
    if (!trip) ctx.reject("out_of_scope");
    await requireCapability(ctx, "van.operate", trip.org_unit_id);
    if (
      !["active", "closing", "reconciling"].includes(trip.status) ||
      !trip.started_at ||
      p.recordedAt < (ms(trip.started_at) ?? 0) ||
      (trip.closed_at && p.recordedAt > (ms(trip.closed_at) ?? 0)) ||
      dateOf(trip.service_date) !== date
    )
      ctx.reject("invalid_transition");
    unitId = trip.org_unit_id;
    vehicleId = trip.vehicle_id;
    tripId = trip.id;
  }
  if (!["start", "stop"].includes(p.trigger)) {
    const near =
      await db`select 1 from location_pings where profile_id=${ctx.actor.profileId} and kind=${kind}
      and recorded_at>${new Date(p.recordedAt - LOCATION_POLICY.minSpacingMs)} and recorded_at<${new Date(p.recordedAt + LOCATION_POLICY.minSpacingMs)} limit 1`;
    if (near.length) ctx.reject("invalid_transition");
  }
  const [row] =
    await db`insert into location_pings(organization_id,kind,profile_id,device_id,client_ping_id,org_unit_id,vehicle_id,trip_id,visit_id,service_date,
    latitude,longitude,accuracy_meters,speed_meters_per_second,heading_degrees,battery_percent,mock_location,provider,trigger,recorded_at,received_at)
    values (${ORGANIZATION},${kind},${ctx.actor.profileId},${ctx.device.id},${p.clientPingId},${unitId},${vehicleId},${tripId},${visitId},${date},
      ${p.latitude},${p.longitude},${p.accuracyMeters},${p.speedMetersPerSecond},${p.headingDegrees},${p.batteryPercent},${p.mockLocation},${p.provider},${p.trigger},${new Date(p.recordedAt)},${new Date(ctx.now)}) returning id`;
  const key =
    kind === "field" ? `field:${ctx.actor.profileId}` : `van:${vehicleId}`;
  // Preserve the live head when older buffered pings arrive after a newer fix.
  const [previous] =
    await db`select * from live_locations where subject_key=${key} for update`;
  if (!previous || p.recordedAt >= (ms(previous.recorded_at) ?? 0)) {
    const moved =
      !previous ||
      distanceMeters(previous, p) >= 50 ||
      (p.speedMetersPerSecond ?? 0) >= 1;
    const movedAt = moved
      ? new Date(p.recordedAt)
      : (previous.last_moved_at ?? previous.recorded_at);
    await db`insert into live_locations(organization_id,kind,subject_key,profile_id,device_id,org_unit_id,vehicle_id,trip_id,visit_id,service_date,
      latitude,longitude,accuracy_meters,speed_meters_per_second,heading_degrees,battery_percent,mock_location,provider,trigger,recorded_at,received_at,tracking_ended,last_moved_at)
      values (${ORGANIZATION},${kind},${key},${ctx.actor.profileId},${ctx.device.id},${unitId},${vehicleId},${tripId},${visitId},${date},
        ${p.latitude},${p.longitude},${p.accuracyMeters},${p.speedMetersPerSecond},${p.headingDegrees},${p.batteryPercent},${p.mockLocation},${p.provider},${p.trigger},${new Date(p.recordedAt)},${new Date(ctx.now)},${trackingEnded},${movedAt})
      on conflict(subject_key) do update set profile_id=excluded.profile_id,device_id=excluded.device_id,org_unit_id=excluded.org_unit_id,vehicle_id=excluded.vehicle_id,trip_id=excluded.trip_id,
        visit_id=excluded.visit_id,service_date=excluded.service_date,latitude=excluded.latitude,longitude=excluded.longitude,accuracy_meters=excluded.accuracy_meters,
        speed_meters_per_second=excluded.speed_meters_per_second,heading_degrees=excluded.heading_degrees,battery_percent=excluded.battery_percent,mock_location=excluded.mock_location,
        provider=excluded.provider,trigger=excluded.trigger,recorded_at=excluded.recorded_at,received_at=excluded.received_at,tracking_ended=excluded.tracking_ended,last_moved_at=excluded.last_moved_at`;
  }
  // A durable coalesced job bounds fanout across all API processes to one / 5s.
  await ctx.enqueue({
    kind: "fieldsync.location-publish",
    key: "location",
    runAt: ctx.now + 5000,
    payload: {},
  });
  await ctx.change("location", row.id, `profile:${ctx.actor.profileId}`);
  return { entityId: row.id, eventIds: [], movementId: null };
}
/** @param {any} ctx */
export async function consent(ctx) {
  const actor = await requireCapability(
    ctx,
    ctx.session?.app === "van-android" ? "van.operate" : "visit.record",
  );
  if (typeof ctx.body?.enabled !== "boolean")
    throw invalid("Choose whether location sharing is enabled");
  if (ctx.body.startDay !== undefined && typeof ctx.body.startDay !== "boolean")
    throw invalid("Choose whether to start location sharing");
  const start = ctx.body.startDay === true;
  const startedAt =
    ctx.body.startedAt === undefined ? ctx.now : ctx.body.startedAt;
  if (start) await requireCapability(ctx, "visit.record", actor.orgUnitId);
  if (
    start &&
    (!ctx.body.enabled ||
      !actor.orgUnitId ||
      !Number.isSafeInteger(startedAt) ||
      startedAt > ctx.now + LOCATION_POLICY.maxFutureSkewMs ||
      ctx.now - startedAt > LOCATION_POLICY.maxAgeMs ||
      new Date(startedAt + 28_800_000).getUTCHours() < 5 ||
      startedAt >= closeAt(manilaDate(startedAt)))
  )
    throw invalid("Start sharing during your work day");
  const result = await tx(ctx.db, async (db) => {
    await personLock(db, actor.profileId);
    if (start) {
      const date = manilaDate(startedAt);
      const [day] =
        await db`select * from fieldsync_work_days where profile_id=${actor.profileId} and service_date=${date}::date for update`;
      if (day?.ended_at && startedAt <= (ms(day.ended_at) ?? 0))
        throw invalid("Start sharing after the previous day end");
      if (!day || day.ended_at) {
        await db`insert into fieldsync_work_days(profile_id,service_date,started_at) values (${actor.profileId},${date},${new Date(startedAt)})
          on conflict(profile_id,service_date) do update set started_at=excluded.started_at,ended_at=null,end_reason=null,updated_at=now()`;
        await db`insert into audit_logs(subject,action,entity_type,entity_id,details) values (${actor.subject},'location.start_day','profile',${actor.profileId},${JSON.stringify({ serviceDate: date, startedAt, previousStartedAt: ms(day?.started_at), previousEndedAt: ms(day?.ended_at) })})`;
      }
    }
    const [prior] =
      await db`select max(effective_from) as at from fieldsync_location_consents where profile_id=${actor.profileId}`;
    const at = Math.max(ctx.now, (ms(prior?.at) ?? 0) + 1);
    const [row] =
      await db`insert into fieldsync_location_consents(profile_id,enabled,effective_from) values (${actor.profileId},${ctx.body.enabled},${new Date(at)}) returning id`;
    if (!ctx.body.enabled)
      await db`update live_locations set tracking_ended=true where profile_id=${actor.profileId}`;
    await db`insert into audit_logs(subject,action,entity_type,entity_id,details) values (${actor.subject},'location.consent','profile',${actor.profileId},${ctx.body.enabled ? "enabled" : "disabled"})`;
    await enqueue(db, {
      kind: "fieldsync.location-publish",
      key: "location",
      runAt: ctx.now + 5000,
      payload: {},
    });
    return { id: row.id, enabled: ctx.body.enabled, effectiveFrom: at };
  });
  return result;
}
/** @param {any} ctx */
export async function endDay(ctx) {
  const actor = await requireCapability(ctx, "visit.record");
  const date = manilaDate(ctx.now);
  await tx(ctx.db, async (db) => {
    await personLock(db, actor.profileId);
    const [first] =
      await db`select min(checked_in_at) as at from visit_executions where assignee_profile_id=${actor.profileId} and service_date=${date}::date and deleted_at is null`;
    if (!first?.at) throw invalid("The day has not started");
    await db`insert into fieldsync_work_days(profile_id,service_date,started_at,ended_at,end_reason)
      values (${actor.profileId},${date},${first.at},${new Date(Math.min(ctx.now, closeAt(date)))},'end_day')
      on conflict(profile_id,service_date) do update set ended_at=coalesce(fieldsync_work_days.ended_at,excluded.ended_at),end_reason=coalesce(fieldsync_work_days.end_reason,excluded.end_reason)`;
    await db`update live_locations set tracking_ended=true where profile_id=${actor.profileId} and kind='field'`;
    await db`insert into audit_logs(subject,action,entity_type,entity_id) values (${actor.subject},'location.end_day','profile',${actor.profileId})`;
    await enqueue(db, {
      kind: "fieldsync.location-publish",
      key: "location",
      runAt: ctx.now + 5000,
      payload: {},
    });
  });
  return { serviceDate: date, ended: true };
}
/** @param {any} ctx */
export async function consentState(ctx) {
  const actor = await requireCapability(ctx, "location.read");
  const [row] =
    await ctx.db`select enabled,effective_from from fieldsync_location_consents where profile_id=${actor.profileId} order by effective_from desc,id desc limit 1`;
  return {
    enabled: row?.enabled ?? false,
    effectiveFrom: ms(row?.effective_from),
  };
}
/** @param {any} ctx */
export async function live(ctx) {
  const people = await visiblePeople(ctx);
  const db = ctx.db;
  const { unitIds } = await scopeFilterForActor(db, ctx.actor);
  const filterUnit = ctx.url.searchParams.get("orgUnitId");
  if (filterUnit) {
    uuid(filterUnit);
    await requireCapability(ctx, "location.read", filterUnit);
  }
  const teamId = ctx.url.searchParams.get("teamId");
  if (teamId) uuid(teamId);
  const ids = people.map((/** @type {any} */ p) => p.id);
  const units = unitIds?.length ? unitIds : [ZERO_UUID];
  const rows = ids.length
    ? await db`
    select l.*,u.name as unit_name,vehicle.vehicle_code,vehicle.plate_number,trip.trip_number,
      team.id as team_id,team.name as team_name,ot.name as visit_outlet_name
    from live_locations l join profiles p on p.id=l.profile_id join org_units u on u.id=l.org_unit_id
    left join vehicles vehicle on vehicle.id=l.vehicle_id
    left join van_trips trip on trip.id=l.trip_id
    left join lateral (select t.id,t.name from team_memberships m join teams t on t.id=m.team_id
      where m.profile_id=p.id and m.effective_from<=${new Date(ctx.now)} and (m.effective_to is null or m.effective_to>${new Date(ctx.now)})
        and t.status='active' and t.effective_from<=${new Date(ctx.now)} and (t.effective_to is null or t.effective_to>${new Date(ctx.now)})
      order by t.id limit 1) team on true
    left join visit_executions v on v.id=l.visit_id and v.checked_out_at is null and v.deleted_at is null
    left join outlets ot on ot.id=v.outlet_id
    where l.profile_id in ${db(ids)} and l.deleted_at is null and l.organization_id=${ORGANIZATION}
      and l.recorded_at>=${new Date(ctx.now - DAY_MS)}
      and (${unitIds === null} or l.org_unit_id in ${db(units)})
      and (${!filterUnit} or l.org_unit_id=${filterUnit ?? ZERO_UUID}::uuid)
      and (${!teamId} or team.id=${teamId ?? ZERO_UUID}::uuid)
    order by l.recorded_at desc,l.id limit 501`
    : [];
  const facts = await dayFacts(db, ids, manilaDate(ctx.now));
  /** @type {any[]} */
  const positions = [];
  for (const r of rows.slice(0, 500)) {
    const person = people.find((/** @type {any} */ p) => p.id === r.profile_id);
    const f = facts.get(r.profile_id);
    const ended =
      r.tracking_ended ||
      dateOf(r.service_date) !== manilaDate(ctx.now) ||
      ctx.now >= closeAt(manilaDate(ctx.now));
    const age = Math.max(
      0,
      ctx.now - Math.min(ms(r.recorded_at) ?? 0, ms(r.received_at) ?? 0),
    );
    const status =
      ended || age >= 1_800_000
        ? "offline"
        : age >= 600_000
          ? "stale"
          : r.visit_outlet_name
            ? "at-store"
            : age < 180_000 &&
                ((r.speed_meters_per_second ?? 0) >= 1 ||
                  r.trigger === "moving")
              ? "moving"
              : "idle";
    const activity = Math.max(
      ms(r.last_moved_at) ?? ms(r.recorded_at) ?? 0,
      ms(f?.last_activity_at) ?? 0,
    );
    positions.push({
      id: r.id,
      kind: r.kind,
      profileId: r.profile_id,
      name: person.name,
      vehicleId: r.vehicle_id,
      vehicleLabel: r.vehicle_code
        ? `${r.vehicle_code} · ${r.plate_number}`
        : null,
      tripNumber: r.trip_number ?? null,
      orgUnitId: r.org_unit_id,
      unitName: r.unit_name,
      teamId: r.team_id ?? null,
      teamName: r.team_name ?? null,
      latitude: r.latitude,
      longitude: r.longitude,
      accuracyMeters: r.accuracy_meters,
      speedMetersPerSecond: r.speed_meters_per_second,
      headingDegrees: r.heading_degrees,
      batteryPercent: r.battery_percent,
      mockLocation: r.mock_location,
      recordedAt: ms(r.recorded_at),
      receivedAt: ms(r.received_at),
      lastSeenAt: ms(r.recorded_at),
      lastMovedAt: ms(r.last_moved_at),
      lastActivityAt: ms(f?.last_activity_at),
      serviceDate: dateOf(r.service_date),
      status,
      freshness: ended
        ? "ended"
        : age >= 1_800_000
          ? "offline"
          : age >= 600_000
            ? "stale"
            : "fresh",
      visitOutletName: r.visit_outlet_name ?? null,
      sample: r.sample === true,
      planned: f?.planned ?? 0,
      visited: f?.visited ?? 0,
      productive: f?.productive ?? 0,
      idleFlag:
        !ended &&
        new Date(ctx.now + 28_800_000).getUTCHours() >= 5 &&
        !!f?.first_check_in_at &&
        ctx.now - activity >= LOCATION_POLICY.idleFlagMs,
    });
  }
  const trend = [];
  // A planned day exists before the first location ping. Never derive workload from
  // the subset of people currently sharing a fix (or the bounded positions list).
  let summaryPeople = people.filter(
    (/** @type {any} */ p) => !filterUnit || p.current_unit_id === filterUnit,
  );
  if (teamId) {
    const members =
      await db`select profile_id from team_memberships where team_id=${teamId} and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`;
    const memberIds = new Set(
      members.map((/** @type {any} */ m) => m.profile_id),
    );
    summaryPeople = summaryPeople.filter((/** @type {any} */ p) =>
      memberIds.has(p.id),
    );
  }
  const visibleIds = summaryPeople.map((/** @type {any} */ p) => p.id);
  for (let days = 6; days >= 0; days--) {
    const day = manilaDate(midnight(manilaDate(ctx.now)) - days * DAY_MS);
    const counts = await dayFacts(db, visibleIds, day);
    const sum = { date: day, planned: 0, visited: 0, productive: 0 };
    for (const value of counts.values()) {
      sum.planned += value.planned;
      sum.visited += value.visited;
      sum.productive += value.productive;
    }
    trend.push(sum);
  }
  return {
    now: ctx.now,
    truncated: rows.length > 500,
    selfOnly: ctx.actor.role === "sales",
    positions,
    trend,
    prior: trend.at(-2),
    units: [
      ...new Map(
        people
          .filter((/** @type {any} */ p) => p.current_unit_id)
          .map((/** @type {any} */ p) => [
            p.current_unit_id,
            {
              id: p.current_unit_id,
              name:
                positions.find((r) => r.orgUnitId === p.current_unit_id)
                  ?.unitName ??
                p.current_unit_name ??
                "Assigned area",
            },
          ]),
      ).values(),
    ],
    teams: [
      ...new Map(
        positions
          .filter((p) => p.teamId)
          .map((p) => [p.teamId, { id: p.teamId, name: p.teamName }]),
      ).values(),
    ],
    idleThresholdMinutes: 45,
    provisional: true,
  };
}
/** @param {any} ctx */
export async function trail(ctx) {
  const id = uuid(ctx.url.searchParams.get("profileId"));
  const date = serviceDate(ctx.url.searchParams.get("date"));
  const person = await personInScope(ctx, id);
  const db = ctx.db;
  const { unitIds } = await scopeFilterForActor(db, ctx.actor);
  const units = unitIds?.length ? unitIds : [ZERO_UUID];
  const rows =
    await db`select * from location_pings where profile_id=${id} and service_date=${date}::date and deleted_at is null
    and (${unitIds === null} or org_unit_id in ${db(units)}) order by recorded_at,id limit ${LOCATION_POLICY.maxTrailPings + 1}`;
  const pings = rows
    .slice(0, LOCATION_POLICY.maxTrailPings)
    .map((/** @type {any} */ r) => ({
      kind: r.kind,
      latitude: r.latitude,
      longitude: r.longitude,
      accuracyMeters: r.accuracy_meters,
      speedMetersPerSecond: r.speed_meters_per_second,
      batteryPercent: r.battery_percent,
      mockLocation: r.mock_location,
      trigger: r.trigger,
      recordedAt: ms(r.recorded_at),
    }));
  const visits =
    await db`select v.*,o.code,o.name,pin.latitude,pin.longitude from visit_executions v join outlets o on o.id=v.outlet_id
    left join lateral (select latitude,longitude from outlet_pins where outlet_id=v.outlet_id and status='verified' and deleted_at is null
      and effective_from<=coalesce(v.checked_in_at,v.created_at) and (effective_to is null or effective_to>coalesce(v.checked_in_at,v.created_at)) limit 1) pin on true
    where v.assignee_profile_id=${id} and v.service_date=${date}::date and v.deleted_at is null and (${unitIds === null} or v.org_unit_id in ${db(units)})
    order by v.checked_in_at nulls last,v.id limit ${LOCATION_POLICY.maxStops + 1}`;
  const stops = visits
    .slice(0, LOCATION_POLICY.maxStops)
    .map((/** @type {any} */ v) => ({
      visitId: v.id,
      outletCode: v.code,
      outletName: v.name,
      state: v.state,
      checkedInAt: ms(v.checked_in_at),
      checkedOutAt: ms(v.checked_out_at),
      latitude: v.latitude ?? null,
      longitude: v.longitude ?? null,
      pinned: v.latitude !== null,
      onPlan: v.planned_visit_id !== null,
      productive: v.productivity === "verified",
    }));
  // A nearby recorded fix is a trail fallback, never a verified store pin.
  for (const stop of stops) {
    if (stop.latitude !== null || stop.checkedInAt === null || !pings.length)
      continue;
    const at = stop.checkedInAt;
    const nearest = pings.reduce(
      (/** @type {any} */ best, /** @type {any} */ point) =>
        Math.abs(point.recordedAt - at) < Math.abs(best.recordedAt - at)
          ? point
          : best,
    );
    if (Math.abs((nearest.recordedAt ?? 0) - at) <= 600_000) {
      stop.latitude = nearest.latitude;
      stop.longitude = nearest.longitude;
    }
  }
  const planned =
    await db`select pv.id,pv.outlet_id,pv.approved_snapshot,s.sequence from planned_visits pv join coverage_plans cp on cp.id=pv.plan_id join coverage_plan_slots s on s.id=pv.plan_slot_id
    where pv.assignee_profile_id=${id} and pv.service_date=${date}::date and pv.status='planned' and pv.deleted_at is null and cp.status in ('approved','active') and cp.approval_signature is not null
    order by s.sequence,pv.id limit ${LOCATION_POLICY.maxStops + 1}`;
  let distance = 0;
  for (let i = 1; i < pings.length; i++)
    distance += distanceMeters(pings[i - 1], pings[i]);
  return {
    profileId: id,
    name: person.name,
    serviceDate: date,
    truncated:
      rows.length > LOCATION_POLICY.maxTrailPings ||
      visits.length > LOCATION_POLICY.maxStops ||
      planned.length > LOCATION_POLICY.maxStops,
    pings,
    stops,
    distanceKm: pings.length < 2 ? null : Math.round(distance / 100) / 10,
    distanceBasis: "recorded_fixes",
    plannedStops: planned
      .slice(0, LOCATION_POLICY.maxStops)
      .map((/** @type {any} */ p) => ({
        plannedVisitId: p.id,
        outletId: p.outlet_id,
        name: p.approved_snapshot.outletName,
        sequence: p.sequence,
        visited: visits.some(
          (/** @type {any} */ v) => v.planned_visit_id === p.id,
        ),
      })),
  };
}
/** Verified store pins, keyset-paged AFTER scope filtering. @param {any} ctx */
export async function storePins(ctx) {
  const actor = await requireCapability(ctx, "location.read");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const cursor = ctx.url.searchParams.get("cursor");
  if (cursor) uuid(cursor);
  const db = ctx.db;
  const units = unitIds?.length ? unitIds : [ZERO_UUID];
  const rows =
    await db`select o.id,o.code,o.name,p.latitude,p.longitude from outlets o
    join outlet_pins p on p.outlet_id=o.id and p.status='verified' and p.deleted_at is null
      and p.effective_from<=${new Date(ctx.now)} and (p.effective_to is null or p.effective_to>${new Date(ctx.now)})
    left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
    left join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=${new Date(ctx.now)} and (own.effective_to is null or own.effective_to>${new Date(ctx.now)})
    where o.deleted_at is null and o.status!='inactive' and (${unitIds === null} or coalesce(own.org_unit_id,o.custodian_org_unit_id) in ${db(units)})
      and (${actor.role !== "sales"} or exists(select 1 from planned_visits pv where pv.assignee_profile_id=${actor.profileId} and pv.outlet_id=o.id and pv.status='planned' and pv.deleted_at is null
        and pv.service_date>=${manilaDate(ctx.now)}::date and pv.service_date<${manilaDate(ctx.now)}::date+3))
      and (${!cursor} or o.id>${cursor ?? ZERO_UUID}::uuid) order by o.id limit 101`;
  return {
    items: rows.slice(0, 100).map((/** @type {any} */ r) => ({
      outletId: r.id,
      code: r.code,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
    })),
    nextCursor: rows.length > 100 ? rows[99].id : null,
  };
}
