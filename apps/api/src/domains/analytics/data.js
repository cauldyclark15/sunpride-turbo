import { isProductive } from "../visits/productive.js";
import { readVanCollections, readVanCredit } from "./van-facts.js";
import {
  ms,
  num,
  sum,
  minTime,
  maxTime,
  pct,
  dateOf,
  daysBetween,
} from "./measures.js";

/** @param {any} db @param {any} s @param {string|null} [channel] */
export async function readPeople(db, s, channel = null) {
  return db`select p.*,pos.label as position_label,st.work_with_weekly_min,st.work_with_monthly_min,
    st.productive_call_target_pct,st.daily_calls_target,
    ts.territory_id,t.name as territory_name
    from analytics_people p left join positions pos on pos.id=p.current_position_id
    left join lateral(select * from position_standards where position_id=p.current_position_id and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by effective_from desc limit 1) st on true
    left join lateral(select territory_id from territory_salespeople ts where ts.profile_id=p.id and ts.deleted_at is null and ts.effective_from<=now() and (ts.effective_to is null or ts.effective_to>now()) order by ts.effective_from desc limit 1) ts on true
    left join territories t on t.id=ts.territory_id
    where p.status='active' and p.current_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and (${s.ownProfileId}::uuid is null or p.id=${s.ownProfileId}) and (${channel}::text is null or p.channel_scope=${channel})`;
}
/** @param {any} db @param {any} s @param {string|null} [channel] */
export async function readStores(db, s, channel = null) {
  return db`select * from analytics_store_scope where owner_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and (${channel}::text is null or channel=${channel})
    and (${s.ownProfileId}::uuid is null or exists(select 1 from territory_salespeople ts where ts.territory_id=analytics_store_scope.territory_id and ts.profile_id=${s.ownProfileId} and ts.deleted_at is null and ts.effective_from<=now() and (ts.effective_to is null or ts.effective_to>now())))`;
}
/** @param {any} db @param {any} p @param {any} s */
export async function readVisits(db, p, s) {
  s.visitReads ??= new Map();
  const key = JSON.stringify([
    p.from,
    p.to,
    p.channel,
    p.storeId ?? null,
    s.ownProfileId,
  ]);
  if (!s.visitReads.has(key)) {
    const work = (s.visitQueue ?? Promise.resolve()).then(() =>
      queryVisits(db, p, s),
    );
    s.visitQueue = work.then(
      () => undefined,
      () => undefined,
    );
    s.visitReads.set(key, work);
  }
  return s.visitReads.get(key);
}
/** @param {any} db @param {any} p @param {any} s */
async function queryVisits(db, p, s) {
  const ids = s.ids.length ? s.ids : [null];
  const [planned, visits, coaching] = await Promise.all([
    db`with people as materialized(select * from analytics_people), stores as materialized(select * from analytics_store_scope)
      select v.*,o.name as store_name,o.territory_id,pe.current_unit_id as org_unit_id from planned_visits v
      join people pe on pe.id=v.assignee_profile_id join stores o on o.id=v.outlet_id
      where v.deleted_at is null and v.status='planned' and v.service_date between ${p.from} and ${p.to} and (${p.storeId ?? null}::uuid is null or v.outlet_id=${p.storeId ?? null})
      and pe.current_unit_id in ${db(ids)} and o.owner_unit_id in ${db(ids)}
      and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) and (${p.channel}::text is null or o.channel=${p.channel})`,
    db`with people as materialized(select * from analytics_people), stores as materialized(select * from analytics_store_scope)
      select v.*,pe.name as agent_name,o.name as store_name,o.territory_id,st.productive_call_rule,
      coalesce(a.kinds,'{}') as activity_kinds,coalesce(a.activities,'[]') as activities,
      coalesce(c.amount,0) as collections_centavos,coalesce(c.n,0) as collection_count,
      coalesce(sale.orders,0) as accepted_orders,coalesce(sale.lines,0) as accepted_lines
      from visit_executions v join people pe on pe.id=v.assignee_profile_id
      join stores o on o.id=v.outlet_id
      left join lateral(select array_agg(activity_kind) as kinds,jsonb_agg(jsonb_build_object('kind',activity_kind,'activity',activity,'deviceTime',extract(epoch from device_time)*1000)) as activities from visit_activities where visit_id=v.id and deleted_at is null) a on true
      left join lateral(select sum(amount_minor) as amount,count(*) as n from field_collections where visit_id=v.id and deleted_at is null and status!='rejected') c on true
      left join lateral(select count(distinct ord.id) orders,count(*) lines from orders ord
        join order_lines line on line.order_id=ord.id and line.deleted_at is null
        where ord.id in (
          select captured.id from orders captured where captured.source_activity_id in(select id from visit_activities where visit_id=v.id and outlet_id=v.outlet_id and deleted_at is null)
          union select fc.order_id from field_order_captures fc where fc.visit_id=v.id)
        and ord.deleted_at is null and ord.status not in ('draft','rejected','voided')
        and ord.salesperson_subject in (pe.auth_subject,pe.user_id::text)
        and (ord.outlet_id is null or ord.outlet_id=v.outlet_id)
        and (ord.source_location_id is null or exists(select 1 from inventory_locations loc where loc.id=ord.source_location_id and loc.deleted_at is null and loc.org_unit_id in ${db(ids)}))) sale on true
      left join lateral(select productive_call_rule from position_standards where position_id=pe.current_position_id and deleted_at is null and effective_from<=v.service_date::timestamp at time zone 'Asia/Manila' and (effective_to is null or effective_to>v.service_date::timestamp at time zone 'Asia/Manila') order by effective_from desc limit 1) st on true
      where v.deleted_at is null and v.service_date between ${p.from} and ${p.to} and (${p.storeId ?? null}::uuid is null or v.outlet_id=${p.storeId ?? null})
      and v.org_unit_id in ${db(ids)} and pe.current_unit_id in ${db(ids)} and o.owner_unit_id in ${db(ids)}
      and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) and (${p.channel}::text is null or o.channel=${p.channel})`,
    db`select w.* from work_with_sessions w join analytics_people pe on pe.id=w.trainer_profile_id where w.status='completed' and w.service_date between ${p.from} and ${p.to} and w.org_unit_id in ${db(ids)} and pe.current_unit_id in ${db(ids)} and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) and (${p.channel}::text is null or pe.channel_scope=${p.channel})`,
  ]);
  const plannedIds = new Set(planned.map((/** @type {any} */ r) => r.id));
  for (const v of visits) {
    v.onPlan = v.source === "planned" && plannedIds.has(v.planned_visit_id);
    v.closed = ["completed", "checked-out"].includes(v.state);
    v.call = v.onPlan && v.closed;
    const facts = {
      ...v,
      source: v.source,
      state: v.state,
      onPlan: v.onPlan,
      inRoutePlan: v.onPlan,
      plannedVisitId: v.planned_visit_id,
      reasonCode: v.reason_code,
      activityKinds: v.activity_kinds,
      activities: v.activities,
      collectionCount: Number(v.collection_count),
      collections: Number(v.collection_count),
      noSalesDueToInventory: v.reason_code === "no_sales_due_to_inventory",
    };
    v.productive = v.call
      ? isProductive(facts, {
          productiveCallRule: v.productive_call_rule ?? "any_listed_activity",
          rule: v.productive_call_rule ?? "any_listed_activity",
        }).productive
      : false;
  }
  return { planned, visits, coaching };
}
/** F-605: per-visit dwell excludes travel and open/invalid intervals. @param {any[]} visits */
export function dwell(visits) {
  const durations = visits
    .filter((v) => v.closed)
    .map((v) => {
      const start = ms(v.started_at) ?? ms(v.checked_in_at);
      const end = ms(v.ended_at) ?? ms(v.checked_out_at);
      return start !== null && end !== null && end >= start
        ? end - start
        : null;
    })
    .filter((v) => v !== null);
  return durations.length
    ? Math.round(durations.reduce((n, v) => n + v, 0) / 6000) / 10
    : null;
}
/** @param {any} facts */
export function visitSummary(facts) {
  const { planned, visits, coaching } = facts;
  const visited = new Set(
    visits
      .filter((/** @type {any} */ v) => v.onPlan && v.closed)
      .map((/** @type {any} */ v) => v.planned_visit_id),
  ).size;
  const first =
    minTime(visits, "started_at") ?? minTime(visits, "checked_in_at");
  const last = maxTime(visits, "ended_at") ?? maxTime(visits, "checked_out_at");
  const productive = visits.filter(
    (/** @type {any} */ v) => v.productive,
  ).length;
  const calls = visits.filter((/** @type {any} */ v) => v.call).length;
  const spans = new Map();
  for (const v of visits) {
    const key = `${v.assignee_profile_id}:${dateOf(v.service_date)}`,
      start = ms(v.started_at) ?? ms(v.checked_in_at),
      end = ms(v.ended_at) ?? ms(v.checked_out_at);
    if (!spans.has(key)) spans.set(key, { first: null, last: null });
    const span = spans.get(key);
    if (start !== null)
      span.first = span.first === null ? start : Math.min(span.first, start);
    if (end !== null)
      span.last = span.last === null ? end : Math.max(span.last, end);
  }
  const timed = [...spans.values()].filter(
    (span) => span.first !== null && span.last !== null,
  );
  const time = timed.length
    ? Math.round(
        timed.reduce((n, span) => n + Math.max(0, span.last - span.first), 0) /
          6000,
      ) / 10
    : null;
  return {
    planned: planned.length,
    visited,
    missed: Math.max(0, planned.length - visited),
    offPlan: visits.filter((/** @type {any} */ v) => !v.onPlan).length,
    productive,
    calls,
    compliance: pct(visited, planned.length),
    productivePct: pct(productive, calls),
    completedCalls: visits.filter((/** @type {any} */ v) => v.closed).length,
    orderCalls: visits.filter(
      (/** @type {any} */ v) => v.closed && Number(v.accepted_orders) > 0,
    ).length,
    strikeRate: pct(
      visits.filter(
        (/** @type {any} */ v) => v.closed && Number(v.accepted_orders) > 0,
      ).length,
      visits.filter((/** @type {any} */ v) => v.closed).length,
    ),
    dwellMin: dwell(visits),
    callLines: sum(
      visits.filter((/** @type {any} */ v) => v.closed),
      "accepted_lines",
    ),
    first,
    last,
    time,
    workWith: coaching.length,
    collections: sum(visits, "collections_centavos"),
  };
}
/** @param {any} db @param {any} p @param {any} s */
export async function readCollections(db, p, s) {
  // Freeze each small authorization roster once. Inlining the lateral store
  // view lets the planner rescan every outlet for every collection row.
  const field =
    await db`with people as materialized(select id,current_unit_id from analytics_people),
    stores as materialized(select id,owner_unit_id,channel from analytics_store_scope)
    select c.* from field_collections c join people pe on pe.id=c.assignee_profile_id join stores o on o.id=c.outlet_id
    where c.deleted_at is null and c.status!='rejected' and (c.device_time at time zone 'Asia/Manila')::date between ${p.from} and ${p.to}
    and c.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and pe.current_unit_id in ${db(s.ids.length ? s.ids : [null])} and o.owner_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) and (${p.channel}::text is null or o.channel=${p.channel})`;
  return [...field, ...(await readVanCollections(db, p, s))];
}
/** Latest shelf observation per SKU/store, not every repeated audit. @param {any} db @param {any} p @param {any} s */
export async function readAvailability(db, p, s) {
  return db`with stores as materialized(select id,owner_unit_id,channel from analytics_store_scope) select distinct on(a.outlet_id,a.product_id) a.* from merchandising_availability a join stores o on o.id=a.outlet_id where a.deleted_at is null and a.service_date between ${p.from} and ${p.to} and a.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and o.owner_unit_id in ${db(s.ids.length ? s.ids : [null])} and (${p.channel}::text is null or o.channel=${p.channel}) and (${s.ownProfileId}::uuid is null or exists(select 1 from merchandising_audits m where m.id=a.audit_id and m.assignee_profile_id=${s.ownProfileId})) order by a.outlet_id,a.product_id,a.service_date desc,a.created_at desc`;
}
/** @param {any} db @param {any} p @param {any} s */
export async function readMoney(db, p, s) {
  const stores = await readStores(db, s, p.channel),
    codes = [
      ...new Set(
        stores.map((/** @type {any} */ o) => o.customer_code).filter(Boolean),
      ),
    ];
  if (!codes.length) return { rows: [], demo: false };
  const records =
    await db`select distinct on (r.details->>'customerCode') r.* from admin_pack_records r where r.kind='ar_balance' and r.period=${p.to.slice(0, 7)} and r.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and r.details->>'customerCode' in ${db(codes)}
    and (r.source='office' or not exists(select 1 from admin_pack_records o where o.kind=r.kind and o.period=r.period and o.organization_id=r.organization_id and o.source='office')) and r.details->>'asOfDate'<=${p.to} order by r.details->>'customerCode',r.details->>'asOfDate' desc,r.created_at desc`;
  const collections = await readCollections(
    db,
    { ...p, from: p.to.slice(0, 7) + "-01" },
    s,
  );
  const rows = records.map((/** @type {any} */ r) => {
    const d = r.details,
      store = stores.find(
        (/** @type {any} */ o) => o.customer_code === d.customerCode,
      );
    const buckets = {
      current: Number(d.currentMinor),
      d1_30: Number(d.days1to30Minor),
      d31_60: Number(d.days31to60Minor),
      d61_90: Number(d.days61to90Minor),
      d90p: Number(d.over90Minor),
    };
    const cs = collections.filter(
      (/** @type {any} */ c) =>
        !c.trip_id &&
        c.customer_id === store.customer_id &&
        dateOf(c.device_time) >= d.asOfDate,
    );
    let paid = sum(cs, "amount_minor");
    for (const k of /** @type {(keyof typeof buckets)[]} */ ([
      "d90p",
      "d61_90",
      "d31_60",
      "d1_30",
      "current",
    ])) {
      const n = Math.min(buckets[k], paid);
      buckets[k] -= n;
      paid -= n;
    }
    const balance = Object.values(buckets).reduce((a, b) => a + b, 0),
      creditLimit =
        store.credit_limit == null
          ? null
          : Math.round(Number(store.credit_limit) * 100);
    return {
      accountId: store.customer_id,
      code: d.customerCode,
      name: d.customerName,
      channel: store.channel,
      agent: null,
      balance,
      ...buckets,
      creditLimit,
      lastPaymentAt: maxTime(cs, "device_time"),
      status:
        creditLimit && balance > creditLimit
          ? "behind"
          : balance - buckets.current > 0
            ? "watch"
            : "ok",
    };
  });
  for (const credit of await readVanCredit(db, p, s)) {
    const amount = Number(credit.balance);
    if (!Number.isSafeInteger(amount))
      throw new Error("Van credit exceeds supported money bound");
    if (amount === 0) continue;
    let row = rows.find(
      (/** @type {any} */ row) => row.code === credit.customer_code,
    );
    if (!row) {
      row = {
        accountId: credit.customer_id,
        code: credit.customer_code,
        name: credit.name,
        channel: credit.channel,
        agent: credit.agent_name,
        balance: 0,
        current: 0,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        d90p: 0,
        creditLimit:
          credit.credit_limit == null
            ? null
            : Math.round(Number(credit.credit_limit) * 100),
        lastPaymentAt: null,
        status: "ok",
      };
      rows.push(row);
    }
    const days = credit.due_date ? daysBetween(credit.due_date, p.to) : 0;
    const bucket =
      days <= 0
        ? "current"
        : days <= 30
          ? "d1_30"
          : days <= 60
            ? "d31_60"
            : days <= 90
              ? "d61_90"
              : "d90p";
    row[bucket] += amount;
    row.balance += amount;
    const last = ms(credit.last_payment);
    if (last != null)
      row.lastPaymentAt = Math.max(row.lastPaymentAt ?? 0, last);
    row.status =
      row.creditLimit && row.balance > row.creditLimit
        ? "behind"
        : row.balance > row.current
          ? "watch"
          : "ok";
  }
  return {
    rows,
    demo: records.some((/** @type {any} */ r) => r.source === "sample"),
  };
}
/** Case conversion, never relabel base pieces as cases. @param {any} db */
export async function readProducts(db) {
  return db`select p.*,u.code as base_uom_code,conv.case_base from products p left join units_of_measure u on u.id=p.base_uom_id
    left join lateral(select c.numerator::numeric/c.denominator*coalesce(p.quantity_scale,1) as case_base from uom_conversions c join units_of_measure f on f.id=c.from_uom_id where c.product_id=p.id and c.to_uom_id=p.base_uom_id and lower(f.code) in ('case','cases','cs') and c.active and c.deleted_at is null and c.effective_from<=now() and (c.effective_to is null or c.effective_to>now()) order by c.effective_from desc limit 1) conv on true
    where p.deleted_at is null and p.active`;
}
/** @param {any} product @param {number|null} base */
export function units(product, base) {
  const scale = Number(product.quantity_scale ?? 1),
    caseBase =
      product.case_base == null
        ? /^(case|cases|cs)$/i.test(product.base_uom_code ?? product.uom)
          ? scale
          : null
        : Number(product.case_base);
  if (base === null)
    return { cases: null, pieces: null, display: "Quantity unavailable" };
  if (!caseBase)
    return {
      cases: null,
      pieces: base / scale,
      display: `${base / scale} ${product.base_uom_code ?? product.uom} (case size not set)`,
    };
  const cases = Math.floor(base / caseBase),
    pieces = (base - cases * caseBase) / scale;
  return { cases, pieces, display: `${cases} cases + ${pieces} pieces` };
}
export { num, ms, daysBetween };
