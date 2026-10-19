import { tx } from "@sunpride/db/client";
import { enqueue } from "../../core/jobs.js";
import { readSales, dateOf, VERSION } from "./measures.js";
import { readVisits, visitSummary } from "./data.js";
import { rebuildSalesCache } from "./read-model.js";

/** @type {WeakMap<object,number>} */
const lastPublished = new WeakMap();
/** Cross-lane seam: callers invoke this AFTER their domain transaction commits.
 * A source date is rebuilt from truth, not incremented, so retries and corrections are exact.
 * @param {any} ctx @param {{kind:'order'|'visit'|'van'|'collection'|'stock'|'target',date:string,unitId:string|null}} req */
export async function enqueueRefresh(ctx, req) {
  const date = dateOf(req.date);
  await enqueue(ctx.db, {
    kind: "analytics.refresh",
    key: date,
    runAt: Date.now() + 200,
    payload: { date },
  });
  await enqueue(ctx.db, {
    kind: "analytics.notify",
    key: "analytics",
    runAt: Math.max(Date.now(), (lastPublished.get(ctx.db) ?? 0) + 5000),
    payload: {},
  });
}
/** @param {any} db @param {string} date */
export async function rebuildDay(db, date) {
  await tx(db, async (t) => {
    await t`set local jit=off`;
    await t`select pg_advisory_xact_lock(hashtext(${`analytics:${date}`}))`;
    await rebuildSalesCache(t, date, date);
    await t`delete from analytics_daily_sales where service_date=${date}`;
    await t`insert into analytics_daily_sales(service_date,profile_id,store_id,product_id,channel,territory_id,category,org_unit_id,sales_centavos,booked,approved,posted,quantity,order_ids,customer_codes,line_count)
      select service_date,profile_id,store_id,product_id,channel,territory_id,category,agent_unit_id,sum(sales_centavos),sum(sales_centavos),coalesce(sum(sales_centavos) filter(where approved),0),coalesce(sum(sales_centavos) filter(where posted),0),sum(quantity),array_agg(distinct order_id),array_agg(distinct customer_code),count(*) from analytics_sales_facts where service_date=${date} group by service_date,profile_id,store_id,product_id,channel,territory_id,category,agent_unit_id`;
    const units = await t`select id from org_units where deleted_at is null`;
    const scope = {
        ids: units.map((/** @type {any} */ r) => r.id),
        ownProfileId: null,
        cross: true,
      },
      period = { from: date, to: date, channel: null };
    const [facts, sales, people] = await Promise.all([
      readVisits(t, period, scope),
      readSales(t, period, scope, "agent"),
      t`select * from analytics_people where status='active'`,
    ]);
    // Include active planned-only employee days, and keep a zero row after cancellation.
    for (const person of people) {
      const v = {
        planned: facts.planned.filter(
          (/** @type {any} */ r) => r.assignee_profile_id === person.id,
        ),
        visits: facts.visits.filter(
          (/** @type {any} */ r) => r.assignee_profile_id === person.id,
        ),
        coaching: [],
      };
      const a = visitSummary(v),
        sale = sales.rows.find((/** @type {any} */ r) => r.key === person.id);
      const [old] =
        await t`select id from agent_daily_metrics where profile_id=${person.id} and service_date=${date}`;
      if (!old && !v.planned.length && !v.visits.length && !sale) continue;
      const first = a.first === null ? null : new Date(a.first),
        last = a.last === null ? null : new Date(a.last);
      const duration = v.visits.reduce(
        (/** @type {number} */ n, /** @type {any} */ r) =>
          n + Number(r.call_duration_ms ?? 0),
        0,
      );
      const [org] =
        await t`select organization_id from org_units where id=${person.current_unit_id}`;
      await t`insert into agent_daily_metrics(organization_id,profile_id,service_date,local_month,org_unit_id,position_id,planned_calls,calls,productive_calls,nonproductive_calls,productive_pct,planned_not_visited,visits,unplanned_visits,open_visits,skipped_visits,late_sync_visits,visits_missing_activities,call_duration_ms,timed_visits,first_start_at,last_end_at,orders,return_orders,buying_accounts,sales_value,collections,collections_pending_review,collections_value,complete,rule_version,metrics_version,computed_at)
        values(${org?.organization_id ?? "sunpride"},${person.id},${date},${date.slice(0, 7)},${person.current_unit_id},${person.current_position_id},${a.planned},${a.calls},${a.productive},${a.calls - a.productive},${a.strikeRate},${a.missed},${v.visits.length},${a.offPlan},${v.visits.filter((/** @type {any} */ r) => ["checked-in", "in-progress", "arrived"].includes(r.state)).length},${v.visits.filter((/** @type {any} */ r) => ["skipped", "missed", "rescheduled"].includes(r.state)).length},${v.visits.filter((/** @type {any} */ r) => r.late_sync_at).length},${v.visits.filter((/** @type {any} */ r) => r.missing_activities?.length).length},${duration},${v.visits.filter((/** @type {any} */ r) => r.call_duration_ms != null).length},${first},${last},${sale?.orders ?? 0},0,${sale?.ubo ?? 0},${(sale?.sales ?? 0) / 100},${v.visits.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + Number(r.collection_count), 0)},0,${a.collections / 100},true,${VERSION},${VERSION},now())
        on conflict(profile_id,service_date) do update set org_unit_id=excluded.org_unit_id,position_id=excluded.position_id,planned_calls=excluded.planned_calls,calls=excluded.calls,productive_calls=excluded.productive_calls,nonproductive_calls=excluded.nonproductive_calls,productive_pct=excluded.productive_pct,planned_not_visited=excluded.planned_not_visited,visits=excluded.visits,unplanned_visits=excluded.unplanned_visits,open_visits=excluded.open_visits,skipped_visits=excluded.skipped_visits,late_sync_visits=excluded.late_sync_visits,visits_missing_activities=excluded.visits_missing_activities,call_duration_ms=excluded.call_duration_ms,timed_visits=excluded.timed_visits,first_start_at=excluded.first_start_at,last_end_at=excluded.last_end_at,orders=excluded.orders,buying_accounts=excluded.buying_accounts,sales_value=excluded.sales_value,collections=excluded.collections,collections_value=excluded.collections_value,computed_at=excluded.computed_at`;
    }
    await t`insert into analytics_refresh_state(service_date,computed_at) values(${date},now()) on conflict(service_date) do update set computed_at=excluded.computed_at,updated_at=now()`;
  });
}
/** @param {any} db */
export async function fullRebuild(db) {
  const dates =
    await db`select distinct service_date from (select service_date from analytics_sales_facts union select service_date from planned_visits union select service_date from visit_executions union select service_date from analytics_refresh_state) dates order by service_date`;
  // Bounded date jobs let the worker resume a nightly rebuild after process failure.
  for (const row of dates)
    await enqueue(db, {
      kind: "analytics.refresh",
      key: dateOf(row.service_date),
      payload: { date: dateOf(row.service_date) },
    });
}
/** @param {any} installCtx */
export function installRefresh(installCtx) {
  installCtx.registerJob(
    "analytics.refresh",
    async (/** @type {any} */ ctx) => {
      await rebuildDay(ctx.db, ctx.payload.date);
      await enqueue(ctx.db, {
        kind: "analytics.notify",
        key: "analytics",
        runAt: Math.max(Date.now(), (lastPublished.get(ctx.db) ?? 0) + 5000),
        payload: {},
      });
    },
  );
  installCtx.registerJob("analytics.notify", async (/** @type {any} */ ctx) => {
    const last = lastPublished.get(ctx.db) ?? 0;
    if (Date.now() - last < 5000) {
      await enqueue(ctx.db, {
        kind: "analytics.notify",
        key: "analytics",
        runAt: last + 5000,
        payload: {},
      });
      return;
    }
    lastPublished.set(ctx.db, Date.now());
    await installCtx.publish("analytics");
  });
  installCtx.scheduler.daily(
    "00:30",
    "Asia/Manila",
    "analytics.nightly",
    async (/** @type {any} */ ctx) => {
      await fullRebuild(ctx.db);
    },
  );
}
