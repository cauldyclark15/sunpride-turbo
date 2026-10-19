import { tx } from "@sunpride/db/client";
import { validDate } from "./measures.js";

/** Operational backfill for a bounded range; a nightly job uses one-day batches.
 * @param {any} db @param {string} from @param {string} to */
export async function rebuildSalesCache(db, from, to) {
  validDate(from);
  validDate(to);
  await tx(db, async (t) => {
    await t`set local jit=off`;
    await t`set local work_mem='64MB'`;
    await t`select pg_advisory_xact_lock(hashtext('analytics.sales-cache'))`;
    // Lock source rows so no write can commit between the projection and its watermark.
    await t`select id from orders where (coalesce(offline_created_at,created_at) at time zone 'Asia/Manila')::date between ${from} and ${to} for share`;
    const [masters] =
      await t`select analytics_master_fingerprint() as fingerprint`;
    await t`delete from analytics_sales_cache where service_date between ${from} and ${to}`;
    await t`insert into analytics_sales_cache select f.*,now(),now(),o.change_seq,l.change_seq from analytics_sales_facts f join orders o on o.id=f.order_id join order_lines l on l.id=f.line_id where service_date between ${from} and ${to}`;
    await t`delete from analytics_sales_tiles where service_date between ${from} and ${to}`;
    await t`insert into analytics_sales_tiles(service_date,group_kind,group_key,label,profile_id,agent_unit_id,owner_unit_id,source_unit_id,source_location_id,channel,territory_id,sales,approved,posted,orders,lines,quantity,buyers,stores)
      select f.service_date,g.kind,coalesce(g.key,'unassigned'),coalesce(g.label,'Unassigned'),f.profile_id,f.agent_unit_id,f.owner_unit_id,f.source_unit_id,f.source_location_id,f.channel,f.territory_id,sum(f.sales_centavos),coalesce(sum(f.sales_centavos) filter(where f.approved),0),coalesce(sum(f.sales_centavos) filter(where f.posted),0),count(distinct f.order_id),count(*),sum(f.quantity),coalesce(array_agg(distinct f.customer_code) filter(where f.sales_centavos>0),'{}'),coalesce(array_agg(distinct f.store_id) filter(where f.sales_centavos>0 and f.store_id is not null),'{}')
      from analytics_sales_cache f cross join lateral(values('agent',f.profile_id::text,f.agent_name),('channel',f.channel,f.channel),('territory',f.territory_id::text,f.territory_name),('store',f.store_id::text,f.store_name),('sku',f.product_id::text,f.product_name),('category',f.category,f.category)) g(kind,key,label)
      where f.service_date between ${from} and ${to}
      group by f.service_date,g.kind,g.key,g.label,f.profile_id,f.agent_unit_id,f.owner_unit_id,f.source_unit_id,f.source_location_id,f.channel,f.territory_id`;
    const [after] =
      await t`select analytics_master_fingerprint() as fingerprint`;
    if (after.fingerprint !== masters.fingerprint)
      throw new Error("analytics masters changed; retry refresh");
    await t`insert into analytics_refresh_state(service_date,computed_at,masters_fingerprint)
      select d::date,transaction_timestamp(),${masters.fingerprint} from generate_series(${from}::date,${to}::date,'1 day'::interval) d
      on conflict(service_date) do update set computed_at=excluded.computed_at,masters_fingerprint=excluded.masters_fingerprint,updated_at=now()`;
  });
}
/** Choose a projection only when every source date is refreshed and no source update is newer.
 * Source changes force a live read until the queued rebuild completes. @param {any} db @param {any} p @param {any} s */
export async function salesSource(db, p, s) {
  s.salesSources ??= new Map();
  const key = `${p.from}:${p.to}`;
  // One repeatable-read snapshot: a verified superset also verifies every subwindow.
  // This is request-local, so it never carries authorization or source validity forward.
  if (!s.salesSources.has(key)) {
    for (const [range, pending] of s.salesSources) {
      const [from, to] = range.split(":");
      if (from <= p.from && to >= p.to && (await pending) === "tiles") {
        s.salesSources.set(key, pending);
        return "tiles";
      }
    }
  }
  if (!s.salesSources.has(key))
    s.salesSources.set(
      key,
      (async () => {
        const [r] =
          await db`with fingerprint as materialized(select analytics_master_fingerprint() as value)
    select not exists(select 1 from generate_series(${p.from}::date,${p.to}::date,'1 day') d left join analytics_refresh_state r on r.service_date=d::date cross join fingerprint f where r.masters_fingerprint is distinct from f.value)
    and not exists(
      select 1 from
       (select l.id,o.change_seq as order_seq,l.change_seq as line_seq from orders o join order_lines l on l.order_id=o.id
        where (coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date between ${p.from} and ${p.to}
        and o.deleted_at is null and l.deleted_at is null and o.status not in ('draft','rejected','voided')) live
      full join (select line_id,source_order_seq,source_line_seq from analytics_sales_cache where service_date between ${p.from} and ${p.to}) cached on cached.line_id=live.id
      where live.id is null or cached.line_id is null or live.order_seq!=cached.source_order_seq or live.line_seq!=cached.source_line_seq) as ready`;
        return r.ready ? "tiles" : "analytics_sales_facts";
      })(),
    );
  return s.salesSources.get(key);
}
