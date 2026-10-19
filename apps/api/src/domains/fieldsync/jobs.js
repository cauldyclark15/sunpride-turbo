import { tx } from "@sunpride/db/client";
import { enqueue } from "../../core/jobs.js";
import { recordChange } from "../../core/sync.js";
import { closeAt, manilaDate, midnight, DAY_MS } from "./model.js";
import { LOCATION_POLICY } from "./location.js";

const BATCH = 500;
/** Coordinate-free housekeeping audit. @param {any} db @param {string} action @param {number} count */
async function audit(db, action, count) {
  if (count)
    await db`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values ('system',${action},'location','retention',${String(count)})`;
}
/** Bounded physical deletion, never soft-delete coordinates past retention. @param {any} db @param {number} [now] */
export async function purgeExpired(db, now = Date.now()) {
  return tx(db, async (t) => {
    const cutoff = new Date(now - LOCATION_POLICY.retentionMs);
    const pings =
      await t`delete from location_pings where id in (select id from location_pings where recorded_at<${cutoff} order by recorded_at limit ${BATCH} for update skip locked) returning id`;
    const live =
      await t`delete from live_locations where id in (select id from live_locations where recorded_at<${cutoff} order by recorded_at limit ${BATCH} for update skip locked) returning id`;
    const more = pings.length === BATCH || live.length === BATCH;
    await audit(t, "location.retention", pings.length + live.length);
    if (more)
      await enqueue(t, {
        kind: "fieldsync.location-purge",
        key: "retention",
        runAt: now,
        payload: {},
      });
    if (live.length)
      await enqueue(t, {
        kind: "fieldsync.location-publish",
        key: "location",
        runAt: now + 5000,
        payload: {},
      });
    return { deleted: pings.length + live.length, more };
  });
}
/** Close work days, NOT visits or money. VAN fallback changes only the status. @param {any} db @param {{now?:number,vanAbsent?:boolean}} [opts] */
export async function closeDays(db, opts = {}) {
  const now = opts.now ?? Date.now();
  const today = manilaDate(now);
  const date = now >= closeAt(today) ? today : manilaDate(midnight(today) - 1);
  return tx(db, async (t) => {
    // Days with no location upload still close after their first server check-in.
    const inserted =
      await t`insert into fieldsync_work_days(profile_id,service_date,started_at)
      select v.assignee_profile_id,v.service_date,min(v.checked_in_at) from visit_executions v
      where v.checked_in_at is not null and v.deleted_at is null and v.service_date<=${date}::date
        and not exists(select 1 from fieldsync_work_days d where d.profile_id=v.assignee_profile_id and d.service_date=v.service_date)
      group by v.assignee_profile_id,v.service_date order by v.service_date limit ${BATCH}
      on conflict(profile_id,service_date) do nothing returning id`;
    const days =
      await t`update fieldsync_work_days set ended_at=(service_date+time '22:00') at time zone 'Asia/Manila',end_reason='daily_close'
      where id in (select id from fieldsync_work_days where ended_at is null and service_date<=${date}::date order by service_date limit ${BATCH} for update skip locked) returning id,profile_id`;
    const live =
      await t`update live_locations set tracking_ended=true where id in (
      select id from live_locations where not tracking_ended and service_date<=${date}::date order by service_date limit ${BATCH} for update skip locked) returning id,profile_id`;
    let trips = [];
    if (opts.vanAbsent)
      trips =
        await t`update van_trips set status='review_required' where id in (
      select id from van_trips where service_date<=${date}::date and status in ('loading','loaded','active','closing','reconciling')
      order by service_date limit ${BATCH} for update skip locked) returning id`;
    await audit(t, "location.daily_close", days.length);
    if (trips.length)
      await audit(t, "location.van_unclosed_fallback", trips.length);
    for (const row of days)
      await recordChange(t, {
        entity: "field.manifest",
        entityId: row.profile_id,
        scopeKey: `profile:${row.profile_id}`,
      });
    if (live.length)
      await enqueue(t, {
        kind: "fieldsync.location-publish",
        key: "location",
        runAt: now + 5000,
        payload: {},
      });
    const more =
      inserted.length === BATCH ||
      days.length === BATCH ||
      live.length === BATCH ||
      trips.length === BATCH;
    if (more)
      await enqueue(t, {
        kind: "fieldsync.day-close",
        key: "day-close",
        runAt: now,
        payload: {},
      });
    return {
      closed: days.length,
      positions: live.length,
      trips: trips.length,
      more,
    };
  });
}
/** @param {any} ctx @param {boolean} vanAbsent */
export function installJobs(ctx, vanAbsent) {
  ctx.registerJob("fieldsync.location-publish", async () => {
    await ctx.publish("location");
  });
  ctx.registerJob(
    "fieldsync.location-purge",
    async (/** @type {any} */ job) => {
      await purgeExpired(job.db);
    },
  );
  ctx.registerJob("fieldsync.day-close", async (/** @type {any} */ job) => {
    await closeDays(job.db, { vanAbsent });
  });
  ctx.scheduler.daily(
    "19:40",
    "Asia/Manila",
    "fieldsync.location-purge",
    async (/** @type {any} */ job) => {
      await purgeExpired(job.db);
    },
  );
  ctx.scheduler.daily(
    "22:00",
    "Asia/Manila",
    "fieldsync.day-close",
    async (/** @type {any} */ job) => {
      await closeDays(job.db, { vanAbsent });
    },
  );
  // Catch up a missed 22:00 tick after a restart (all operations idempotent).
  ctx.scheduler.every(
    DAY_MS / 24,
    "fieldsync.day-close-catchup",
    async (/** @type {any} */ job) => {
      await closeDays(job.db, { vanAbsent });
    },
  );
}
