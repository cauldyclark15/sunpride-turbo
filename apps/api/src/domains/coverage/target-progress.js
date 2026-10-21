import { tx } from "@sunpride/db/client";
import { ApiError } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { productFor } from "../van/facts.js";
import { scopeFor, monthEnd, prorate } from "../analytics/measures.js";
import { targetBook } from "../analytics/targets.js";
import { orderedDb } from "../analytics/ordered-db.js";
import { VAN_SALES_SQL, SALES_COLUMNS } from "../analytics/van-facts.js";
import { availabilityPeriod } from "../availability/metrics.js";
import {
  dateOf,
  midnight,
  manilaDate,
  rebootstrap,
  serviceDate,
  bounded,
} from "../fieldsync/model.js";
import { METRICS } from "./target-cascade.js";
const previous = (/** @type {string} */ m) =>
  new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 2, 1))
    .toISOString()
    .slice(0, 7);
const value = (/** @type {any} */ v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    throw new ApiError(
      "invalid_metric",
      409,
      "Metric exceeds the supported range",
    );
  return n;
};
/** F-615: own published targets and current-scope canonical actuals; no parent total is handed to a rep.
 * @param {any} context @param {string} day */
export async function targetProgress(context, day) {
  serviceDate(day);
  return tx(context.db, async (raw) => {
    await raw`set transaction isolation level repeatable read`;
    const db = orderedDb(raw),
      actor = await currentActor(db, context.actor);
    const ctx = {
      ...context,
      db,
      actor,
      url: new URL("http://internal/targets"),
    };
    const scope = { ...(await scopeFor(ctx)), ownProfileId: actor.profileId };
    const ids = scope.ids.length ? scope.ids : [null],
      month = day.slice(0, 7),
      priorMonth = previous(month);
    const priorTo =
      priorMonth +
      "-" +
      String(Math.min(+day.slice(8), +monthEnd(priorMonth).slice(8))).padStart(
        2,
        "0",
      );
    const published = bounded(
      await db`select c.id,c.metric,c.product_code,c.unit,c.parent_level,c.version,c.source_ref,c.content_hash,l.amount from target_cascades c join target_cascade_lines l on l.cascade_id=c.id where c.month=${month} and c.status='published' and c.child_level='agent' and l.child_key=${actor.profileId} order by c.metric,c.product_code,c.version desc limit 501`,
      500,
    );
    const books = await targetBook(db, scope, month);
    const records = bounded(
      await db`with office as (
    select ${raw.unsafe(SALES_COLUMNS)},null::uuid van_unit_id,f.line_id
    from analytics_sales_facts f),
    canonical as(select * from office union all select ${raw.unsafe(SALES_COLUMNS)},v.van_unit_id,null::uuid line_id from ${raw.unsafe(VAN_SALES_SQL)} v)
    select f.*,p.code product_code,case when f.line_id is null then f.quantity else ol.quantity_base::numeric/nullif(coalesce(ip.quantity_scale,p.quantity_scale,1),0) end base_quantity
    from canonical f join products p on p.id=f.product_id left join order_lines ol on ol.id=f.line_id
    left join product_inventory_policies ip on ip.product_id=p.id and ip.active and ip.deleted_at is null
    where f.profile_id=${actor.profileId} and f.approved and f.service_date between ${priorMonth + "-01"} and ${day}
      and f.agent_unit_id in ${db(ids)} and (f.owner_unit_id in ${db(ids)} or (f.store_id is null and ${scope.cross}))
      and (f.source_location_id is null or f.source_unit_id in ${db(ids)}) and (f.van_unit_id is null or f.van_unit_id in ${db(ids)}) order by f.service_date,f.order_id,f.product_id limit 5001`,
      5000,
    );
    const calls =
      await db`with stores as materialized(select * from analytics_store_scope),events as(
   select v.id,v.service_date from visit_executions v join stores o on o.id=v.outlet_id where v.assignee_profile_id=${actor.profileId} and v.deleted_at is null and v.checked_out_at is not null and v.late_review_status is distinct from 'rejected' and v.org_unit_id in ${db(ids)} and o.owner_unit_id in ${db(ids)}
   union all
   select a.id,t.service_date from van_trip_observations a join van_trips t on t.id=a.trip_id join stores o on o.id=(a.facts->>'outletId')::uuid where a.kind='stop' and a.facts->>'phase'='departure' and t.salesperson_profile_id=${actor.profileId} and t.deleted_at is null and t.status<>'cancelled' and t.org_unit_id in ${db(ids)} and o.owner_unit_id in ${db(ids)})
   select service_date,count(*)::int n from events where service_date between ${priorMonth + "-01"} and ${day} group by service_date`;
    const current = records.filter(
        (/** @type {any} */ r) => dateOf(r.service_date).slice(0, 7) === month,
      ),
      prior = records.filter(
        (/** @type {any} */ r) =>
          dateOf(r.service_date) >= priorMonth + "-01" &&
          dateOf(r.service_date) <= priorTo,
      );
    const av = await availabilityPeriod(
      db,
      { from: month + "-01", to: day, channel: null, days: +day.slice(8) },
      scope,
    );
    const priorAv = await availabilityPeriod(
      db,
      {
        from: priorMonth + "-01",
        to: priorTo,
        channel: null,
        days: +priorTo.slice(8),
      },
      scope,
    );
    const msl = (/** @type {any} */ a) =>
      a.universe?.fresh && a.required > 0 && a.checked === a.required
        ? Math.round((a.present * 10000) / a.required)
        : null;
    /** @param {string} metric @param {any[]} rows @param {string|null} product @param {string} from @param {string} to @returns {number|null} */
    function actual(metric, rows, product, from, to) {
      if (metric === "sales_value")
        return rows.reduce((n, r) => n + value(r.sales_centavos), 0);
      if (metric === "coverage_stores")
        return new Set(
          rows
            .filter((r) => value(r.sales_centavos) > 0 && r.store_id)
            .map((r) => r.store_id),
        ).size;
      if (metric === "distribution_points")
        return new Set(
          rows
            .filter((r) => r.store_id)
            .map((r) => `${r.store_id}:${r.product_id}`),
        ).size;
      if (metric === "calls")
        return calls
          .filter(
            (/** @type {any} */ r) =>
              dateOf(r.service_date) >= from && dateOf(r.service_date) <= to,
          )
          .reduce(
            (/** @type {number} */ n, /** @type {any} */ r) => n + Number(r.n),
            0,
          );
      if (metric === "volume") {
        const own = rows.filter((r) => r.product_code === product);
        return own.some((r) => r.base_quantity == null)
          ? null
          : own.reduce((n, r) => n + value(r.base_quantity), 0);
      }
      return null;
    }
    const depth = /** @type {Record<string,number>} */ ({
      company: 0,
      channel: 1,
      territory: 2,
    });
    const keys = [
      ...Object.keys(METRICS)
        .filter((k) => k !== "volume")
        .map((metric) => ({ metric, product: null })),
      ...new Set(
        published
          .filter((/** @type {any} */ r) => r.metric === "volume")
          .map((/** @type {any} */ r) => r.product_code),
      ),
    ].map((k) =>
      typeof k === "string" ? { metric: "volume", product: k } : k,
    );
    if (!keys.some((k) => k.metric === "volume"))
      keys.push({ metric: "volume", product: null });
    if (keys.length > 105)
      throw new ApiError(
        "too_many_targets",
        409,
        "Narrow the published personal product targets",
      );
    const rows = [];
    for (const key of keys) {
      const definition =
        METRICS[/** @type {keyof typeof METRICS} */ (key.metric)];
      const all = published.filter(
        (/** @type {any} */ r) =>
          r.metric === key.metric && (r.product_code ?? null) === key.product,
      );
      const max = Math.max(
        -1,
        ...all.map((/** @type {any} */ r) => depth[r.parent_level]),
      );
      const candidates = all.filter(
        (/** @type {any} */ r) => depth[r.parent_level] === max,
      );
      const chosen = candidates.length === 1 ? candidates[0] : null;
      const target =
        key.metric === "sales_value"
          ? books.amount("agent", actor.profileId)
          : chosen
            ? value(chosen.amount)
            : null;
      let unit = definition.unit,
        label = definition.label,
        problem =
          candidates.length > 1
            ? "Conflicting published personal allocations"
            : null;
      let measured =
          key.metric === "msl_compliance"
            ? msl(av)
            : actual(key.metric, current, key.product, month + "-01", day),
        before =
          key.metric === "msl_compliance"
            ? msl(priorAv)
            : actual(
                key.metric,
                prior,
                key.product,
                priorMonth + "-01",
                priorTo,
              );
      if (key.metric === "volume") {
        if (!key.product) {
          measured = null;
          before = null;
          problem = "Publish a product-specific base-unit target";
        } else {
          const [p] =
            await db`select id,name from products where code=${key.product} and active and deleted_at is null`;
          const governed = p ? await productFor(db, p.id, context.now) : null;
          label = p ? `${definition.label} · ${p.name}` : definition.label;
          unit = governed?.base_code ?? "base units";
          if (!governed || chosen?.unit !== unit) {
            measured = null;
            before = null;
            problem =
              "Republish this volume target in its current governed base unit";
          }
        }
      }
      const pace =
        target === null
          ? null
          : definition.additive
            ? prorate(target, month, month + "-01", day)
            : target;
      rows.push({
        metric: key.metric,
        productCode: key.product,
        label,
        unit,
        target,
        actual: measured,
        prior: before,
        paceTarget: pace,
        attainmentBasisPoints:
          target && measured !== null
            ? Math.round((measured * 10000) / target)
            : null,
        gap:
          target === null || measured === null
            ? null
            : Math.max(0, target - measured),
        status:
          target === null
            ? "not_set"
            : measured === null
              ? "unknown"
              : measured >= target
                ? "on_target"
                : measured >= (pace ?? target)
                  ? "on_pace"
                  : "behind",
        sourceRef: chosen?.source_ref ?? null,
        version: chosen?.version ?? null,
        contentHash: chosen?.content_hash ?? null,
        nextAction:
          problem ??
          (target === null
            ? "Ask the office to publish your personal allocation"
            : measured === null
              ? "Complete the governed assessment before claiming progress"
              : key.metric === "msl_compliance"
                ? "Restore missing must-stock lines at the next authorized store"
                : key.metric === "calls"
                  ? "Complete the next authorized planned call"
                  : "Review the next planned store and held orders"),
      });
    }
    return {
      version: 1,
      profileId: actor.profileId,
      month,
      asOfDate: day,
      generatedAt: context.now,
      expiresAt: midnight(day) + 86400000,
      source: "canonical_operational_actuals",
      definition:
        "Approved orders and accepted van sales before returns; product volume in governed base units. Calls are completed visits / recorded van departures. Missing MSL assessment remains unknown. Pending phone work is not yet an office actual.",
      rows,
    };
  });
}
/** @param {any} router @param {any} platform */
export function installTargetProgress(router, platform) {
  router.get("/api/v1/targets/progress", (/** @type {any} */ c) =>
    targetProgress(
      c,
      serviceDate(c.url.searchParams.get("serviceDate") ?? manilaDate(c.now)),
    ),
  );
  platform.registerProjection("targets.progress", {
    params: (/** @type {any} */ p) => ({
      serviceDate: serviceDate(p.serviceDate),
    }),
    snapshot: async (/** @type {any} */ c) => {
      if (c.params.serviceDate !== manilaDate(c.now)) throw rebootstrap();
      return {
        data: await targetProgress(c, c.params.serviceDate),
        next: null,
      };
    },
    entities: [],
    scopeKeys: () => {
      throw rebootstrap("Refresh targets with a signed snapshot");
    },
    leaseExpiresAt: (/** @type {any} */ c) =>
      midnight(c.params.serviceDate) + 86400000,
  });
}
