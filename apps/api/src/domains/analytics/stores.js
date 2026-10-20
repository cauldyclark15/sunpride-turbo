import { outletContext } from "./context-adapter.js";
import {
  kpi,
  sum,
  pct,
  delta,
  addDays,
  daysBetween,
  dateOf,
  ms,
  maxTime,
  readSales,
  dates,
} from "./measures.js";
import {
  readStores,
  readProducts,
  units,
  readVisits,
  readAvailability,
  readMoney,
} from "./data.js";
import { suggestLine, historyDays } from "./suggested-order.js";
import { ApiError } from "../../core/errors.js";
import { releasesAt } from "../availability/masters.js";
import { callSnapshot } from "../availability/calls.js";
import { bounded } from "../fieldsync/model.js";
import { historicalFacts } from "./history.js";

/** @param {any} db @param {any} p @param {any} s */
async function storeFacts(db, p, s) {
  const [earliest] =
    await db`select min((coalesce(offline_created_at,created_at) at time zone 'Asia/Manila')::date) as date from orders`;
  const historyPeriod = {
    ...p,
    from: earliest.date ? dateOf(earliest.date) : p.from,
    selectedFrom: p.from,
  };
  const [stores, current, prior, money, last, availability] = await Promise.all(
    [
      readStores(db, s, p.channel),
      readSales(db, p, s, "store"),
      readSales(db, { ...p, ...p.compare }, s, "store"),
      readMoney(db, p, s),
      historicalFacts(db, historyPeriod, s),
      readAvailability(db, p, s),
    ],
  );
  const visits =
    await db`with stores as materialized(select id,owner_unit_id from analytics_store_scope), people as materialized(select id,current_unit_id from analytics_people) select v.outlet_id,max(coalesce(v.started_at,v.checked_in_at)) as last_visit from visit_executions v join stores o on o.id=v.outlet_id join people pe on pe.id=v.assignee_profile_id where v.deleted_at is null and v.service_date<=${p.to} and v.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and pe.current_unit_id in ${db(s.ids.length ? s.ids : [null])} and o.owner_unit_id in ${db(s.ids.length ? s.ids : [null])} and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) group by v.outlet_id`;
  const rows = stores.map((/** @type {any} */ o) => {
    const c = current.rows.find((/** @type {any} */ r) => r.key === o.id),
      prev = prior.rows.find((/** @type {any} */ r) => r.key === o.id),
      history = last.find((/** @type {any} */ r) => r.store_id === o.id),
      av = availability.filter((/** @type {any} */ a) => a.outlet_id === o.id);
    const active = (c?.sales ?? 0) > 0,
      previous = (prev?.sales ?? 0) > 0,
      first = history?.first_date ? dateOf(history.first_date) : null;
    const state = active
      ? first && first >= p.from
        ? "new"
        : "active"
      : previous
        ? "lost"
        : history
          ? "dormant"
          : "never";
    return {
      storeId: o.id,
      code: o.code,
      name: o.name,
      channel: o.channel,
      territory: o.territory_name ?? null,
      status: state,
      salesPeriod: c?.sales ?? 0,
      salesPrior: prev?.sales ?? 0,
      deltaPct: delta(c?.sales ?? 0, prev?.sales ?? 0),
      lastOrderAt: ms(history?.last_order),
      lastVisitAt: ms(
        visits.find((/** @type {any} */ v) => v.outlet_id === o.id)?.last_visit,
      ),
      skuCount: Number(history?.skus ?? 0),
      mustSellGaps: av.length
        ? av.filter(
            (/** @type {any} */ a) =>
              a.required && ["out_of_stock", "not_carried"].includes(a.status),
          ).length
        : null,
      arBalance:
        money.rows.find((/** @type {any} */ r) => r.accountId === o.customer_id)
          ?.balance ?? null,
    };
  });
  return { stores, rows, current, prior, money };
}
/** @param {any} ctx @param {any} p @param {any} s */
export async function storesPage(ctx, p, s) {
  const { rows, current, prior } = await storeFacts(ctx.db, p, s),
    q = ctx.url.searchParams;
  const week = (/** @type {string} */ d) =>
    addDays(d, -((new Date(d).getUTCDay() + 6) % 7));
  const weekly = [
    ...new Set(current.days.map((/** @type {any} */ d) => week(d.key))),
  ].map((weekStart) => ({
    week: weekStart,
    n: new Set(
      current.days
        .filter((/** @type {any} */ d) => week(d.key) === weekStart)
        .flatMap((/** @type {any} */ d) => d.buyers ?? []),
    ).size,
  }));
  const state = q.get("status"),
    search = (q.get("q") ?? "").toLowerCase(),
    cursor = q.get("cursor"),
    limit = Number(q.get("limit") ?? 50);
  if (
    (state && !["active", "dormant", "new", "lost", "never"].includes(state)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new ApiError(
      "invalid_filter",
      400,
      "Choose a valid store filter and limit from 1 to 200",
    );
  const filtered = rows
    .filter(
      (/** @type {any} */ r) =>
        (!state ||
          (state === "active"
            ? ["active", "new"].includes(r.status)
            : r.status === state)) &&
        (!search || `${r.code} ${r.name}`.toLowerCase().includes(search)) &&
        (!cursor || r.storeId > cursor),
    )
    .sort((/** @type {any} */ a, /** @type {any} */ b) =>
      a.storeId.localeCompare(b.storeId),
    );
  return {
    kpis: [
      kpi(
        "universe",
        "Store universe",
        rows.length,
        "count",
        null,
        null,
        "All currently authorized outlets, independent of buying activity.",
      ),
      kpi(
        "activeBuying",
        "Active buying stores",
        rows.filter((/** @type {any} */ r) => r.salesPeriod > 0).length,
        "count",
        null,
        rows.filter((/** @type {any} */ r) => r.salesPrior > 0).length,
        "Stores with a positive net sale in the selected period.",
      ),
      kpi(
        "ubo",
        "Unique buying accounts",
        current.total.ubo,
        "count",
        null,
        prior.total.ubo,
        "Distinct accounting customer codes with a positive included sale.",
      ),
      kpi(
        "newStores",
        "New buying stores",
        rows.filter((/** @type {any} */ r) => r.status === "new").length,
        "count",
        null,
        null,
        "Stores whose first included order falls inside this period.",
      ),
      kpi(
        "lostStores",
        "Lost stores",
        rows.filter((/** @type {any} */ r) => r.status === "lost").length,
        "count",
        null,
        null,
        "Stores buying in the comparison period but not this period.",
      ),
      kpi(
        "dormant",
        "Dormant stores",
        rows.filter((/** @type {any} */ r) => r.status === "dormant").length,
        "count",
        null,
        null,
        "Historically buying stores with no sale in either selected window.",
      ),
    ],
    uboTrend: [...new Set(dates(p.from, p.to).map(week))].map((weekStart) => ({
      weekStart,
      ubo: Number(
        weekly.find((/** @type {any} */ w) => dateOf(w.week) === weekStart)
          ?.n ?? 0,
      ),
    })),
    rows: q.get("format") === "xlsx" ? filtered : filtered.slice(0, limit),
    next:
      q.get("format") === "xlsx"
        ? null
        : filtered.length > limit
          ? filtered[limit - 1].storeId
          : null,
  };
}
/** @param {any} ctx @param {any} p @param {any} s */
export async function storePage(ctx, p, s) {
  const db = ctx.db,
    id = ctx.url.searchParams.get("storeId"),
    all = await readStores(db, s, p.channel),
    store = all.find((/** @type {any} */ r) => r.id === id);
  if (!store)
    throw new ApiError("out_of_scope", 403, "This store is outside your team");
  const [sales, prior, visitFacts, av, money, products] = await Promise.all([
    readSales(db, p, s, "store", `store:${id}`),
    readSales(db, { ...p, ...p.compare }, s, "store", `store:${id}`),
    readVisits(db, { ...p, storeId: id }, s),
    readAvailability(db, p, s),
    readMoney(db, p, s),
    readProducts(db),
  ]);
  const visits = visitFacts.visits.filter(
      (/** @type {any} */ r) => r.outlet_id === id,
    ),
    observations = av.filter((/** @type {any} */ a) => a.outlet_id === id);
  const retail = (
    await releasesAt(db, "msl", Date.parse(p.to + "T23:59:59+08:00"))
  ).length
    ? await callSnapshot({ ...ctx, app: "web" }, store.id, p.to, false)
    : { lines: [] };
  const retailChecks = bounded(
    await db`select c.* from availability_checks c join analytics_people pe on pe.id=c.profile_id where c.outlet_id=${id} and c.service_date between ${p.from} and ${p.to} and c.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and pe.current_unit_id in ${db(s.ids.length ? s.ids : [null])} and (${s.ownProfileId ?? null}::uuid is null or c.profile_id=${s.ownProfileId ?? null}) order by c.device_time desc,c.id desc limit 30001`,
    30000,
  );
  const lastCalls = new Map();
  for (const c of retailChecks)
    if (!lastCalls.has(`${c.profile_id}:${c.call_key}`))
      lastCalls.set(`${c.profile_id}:${c.call_key}`, c);
  const osa = pct(
    [...lastCalls.values()].reduce((n, c) => n + c.present_count, 0),
    [...lastCalls.values()].reduce((n, c) => n + c.required_count, 0),
  );
  const ar =
    money.rows.find((/** @type {any} */ r) => r.accountId === store.customer_id)
      ?.balance ?? null;
  const history = await historicalFacts(
    db,
    { ...p, from: addDays(p.to, -83) },
    s,
    id,
  );
  const [assortment, next, promotions, stock] = await Promise.all([
    db`select ap.product_id from outlet_assortments a join outlet_assortment_products ap on ap.outlet_assortment_id=a.id where a.outlet_id=${id} and a.deleted_at is null and ap.deleted_at is null and a.effective_from<=${p.to + "T23:59:59+08:00"} and (a.effective_to is null or a.effective_to>${p.to + "T23:59:59+08:00"})`,
    db`select min(service_date) as next from planned_visits where outlet_id=${id} and status='planned' and deleted_at is null and service_date>${p.to} and assignee_profile_id in(select id from analytics_people where current_unit_id in ${db(s.ids.length ? s.ids : [null])})`,
    db`select * from suggested_order_promotions where deleted_at is null and effective_from<=${p.to + "T23:59:59+08:00"} and (effective_to is null or effective_to>${p.to + "T23:59:59+08:00"})`,
    db`select b.* from inventory_balances b join inventory_locations l on l.id=b.location_id where l.allows_sale and l.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and b.deleted_at is null and l.deleted_at is null`,
  ]);
  const productIds = new Set([
    ...retail.lines.map((/** @type {any} */ r) => r.productId),
    ...assortment.map((/** @type {any} */ a) => a.product_id),
    ...history.map((/** @type {any} */ r) => r.product_id),
  ]);
  const suggestions = [],
    assortmentRows = [];
  const first = history.length
    ? dateOf(history[history.length - 1].service_date)
    : null;
  const nextDays = next[0].next
    ? daysBetween(p.to, dateOf(next[0].next))
    : Number(store.cycle_days ?? 7);
  for (const product of products.filter((/** @type {any} */ pr) =>
    productIds.has(pr.id),
  )) {
    const h = history.filter(
        (/** @type {any} */ r) => r.product_id === product.id,
      ),
      latest = h[0],
      obs = observations.find(
        (/** @type {any} */ a) => a.product_id === product.id,
      );
    assortmentRows.push({
      productId: product.id,
      code: product.code,
      name: product.name,
      lastBoughtAt: ms(latest?.created_at),
      onShelf: obs ? ["available", "low_stock"].includes(obs.status) : null,
    });
    const lastDate = latest ? dateOf(latest.service_date) : null,
      lastQty = sum(
        h.filter((/** @type {any} */ r) => dateOf(r.service_date) === lastDate),
        "quantity",
      );
    const bs = stock.filter(
      (/** @type {any} */ b) => b.product_id === product.id,
    );
    const caseBase =
      product.case_base == null
        ? /^(case|cases|cs)$/i.test(product.uom)
          ? Number(product.quantity_scale ?? 1)
          : null
        : Number(product.case_base);
    const sellingBase = /^(case|cases|cs)$/i.test(product.uom)
      ? caseBase
      : Number(product.quantity_scale ?? 1);
    const quantity =
      bs.length && sellingBase ? sum(bs, "available_base") / sellingBase : null;
    const uplift = Math.max(
      0,
      ...promotions
        .filter((/** @type {any} */ r) => r.product_id === product.id)
        .map((/** @type {any} */ r) => Number(r.uplift_pct)),
    );
    const suggestion = suggestLine(
      {
        historyQuantity: sum(h, "quantity"),
        unit: product.uom,
        lastPurchaseDate: lastDate,
        lastPurchaseQuantity: latest ? lastQty : null,
        observation:
          obs && ["out_of_stock", "not_carried"].includes(obs.status)
            ? { date: dateOf(obs.service_date), quantity: 0 }
            : null,
        upliftPct: uplift,
        available: quantity,
      },
      {
        historyDays: historyDays(first, p.to),
        asOfDate: p.to,
        nextVisitDays: nextDays,
        leadTimeDays: 1,
      },
    );
    const retailLine = retail.lines.find(
      (/** @type {any} */ r) => r.productId === product.id,
    );
    const recommendedBase = retailLine
      ? retailLine.quantityBase
      : sellingBase
        ? Math.round(suggestion.quantity * sellingBase)
        : null;
    suggestions.push({
      productId: product.id,
      quantityDisplay:
        recommendedBase != null
          ? units(product, recommendedBase).display
          : "Quantity unavailable",
      qtyCases:
        caseBase && recommendedBase != null ? recommendedBase / caseBase : null,
      reason:
        (retailLine ? retailLine.reasons.join("; ") : suggestion.reason) +
        (caseBase ? "" : "; case size not set"),
    });
  }
  const orderIds = [
    ...new Set(history.map((/** @type {any} */ row) => row.order_id)),
  ];
  const orderNumbers =
    await db`select id,order_number from orders where id in ${db(orderIds.length ? orderIds : [null])}
      union all select id,receipt_number order_number from van_sales where id in ${db(orderIds.length ? orderIds : [null])}`;
  const orderMap = new Map();
  for (const h of history) {
    if (!orderMap.has(h.order_id))
      orderMap.set(h.order_id, {
        orderId: h.order_id,
        number:
          orderNumbers.find((/** @type {any} */ row) => row.id === h.order_id)
            ?.order_number ?? "Order",
        lines: 0,
        at: ms(h.created_at),
        status: h.status,
        totalCentavos: 0,
      });
    orderMap.get(h.order_id).totalCentavos += Number(h.sales_centavos);
    orderMap.get(h.order_id).lines += 1;
  }
  const week = (/** @type {string} */ d) =>
    addDays(d, -((new Date(d).getUTCDay() + 6) % 7));
  const weekly = new Map();
  for (const r of history) {
    const w = week(dateOf(r.service_date));
    weekly.set(w, (weekly.get(w) ?? 0) + Number(r.sales_centavos));
  }
  const context = await outletContext(db, p, s, store);
  context.coverage = {
    planned: visitFacts.planned.length,
    visited: visits.filter((/** @type {any} */ v) => v.onPlan && v.closed)
      .length,
    missed: visitFacts.planned.filter(
      (/** @type {any} */ plan) =>
        !visits.some(
          (/** @type {any} */ v) => v.planned_visit_id === plan.id && v.closed,
        ),
    ).length,
  };
  if (context.availability)
    context.availability.frequencyAchieved = visits.filter(
      (/** @type {any} */ v) => v.closed,
    ).length;
  return {
    context,
    store: {
      id: store.id,
      storeId: store.id,
      code: store.code,
      name: store.name,
      channel: store.channel,
      territory: store.territory_name ?? null,
      address: store.address,
      status: store.status,
    },
    kpis: [
      kpi(
        "salesPeriod",
        "Sales this period",
        sales.total.sales,
        "php",
        null,
        prior.total.sales,
        "The shared net included order-line value for this store.",
      ),
      kpi(
        "visitsPeriod",
        "Visits this period",
        visits.length,
        "count",
        null,
        null,
        "Stored visit executions within this service-date period.",
      ),
      kpi(
        "avgDrop",
        "Average drop",
        sales.total.orders
          ? Math.round(sales.total.sales / sales.total.orders)
          : null,
        "php",
        null,
        null,
        "Store net sales divided by included orders.",
      ),
      kpi(
        "skuCount",
        "SKUs bought",
        new Set(
          history
            .filter((/** @type {any} */ r) => dateOf(r.service_date) >= p.from)
            .map((/** @type {any} */ r) => r.product_id),
        ).size,
        "count",
        null,
        null,
        "Distinct products on included orders in this period.",
      ),
      kpi(
        "osa",
        "On-shelf availability",
        context.availability?.osa ?? null,
        "pct",
        100,
        null,
        "Fresh available assigned MSL lines divided by all assigned MSL lines; incomplete checks are unknown.",
      ),
      kpi(
        "arBalance",
        "Account receivable",
        ar,
        "php",
        null,
        null,
        "Authorized customer aging balance; shared customer amount is not an outlet-specific debt.",
      ),
    ],
    salesTrend: [
      ...new Set(dates(week(addDays(p.to, -77)), p.to).map(week)),
    ].map((weekStart) => ({ weekStart, sales: weekly.get(weekStart) ?? 0 })),
    visits: visits
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          (ms(b.started_at) ?? 0) - (ms(a.started_at) ?? 0),
      )
      .slice(0, 10)
      .map((/** @type {any} */ v) => ({
        visitId: v.id,
        at: ms(v.started_at) ?? ms(v.checked_in_at),
        agent: v.agent_name,
        outcome: v.state.replaceAll("_", " ").replaceAll("-", " "),
        state: v.state,
        onPlan: v.onPlan,
        productive: v.productive,
      })),
    orders: [...orderMap.values()]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 10),
    assortment: assortmentRows,
    suggestedOrder: suggestions,
  };
}
