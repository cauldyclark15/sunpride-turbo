import { availabilityModel } from "./availability-adapter.js";
import {
  kpi,
  sum,
  knownSum,
  num,
  ms,
  dateOf,
  status,
  pct,
  readSales,
} from "./measures.js";
import {
  readProducts,
  units,
  readAvailability,
  readCollections,
  readMoney,
} from "./data.js";

/** Canonical VAN settlement sources, scoped by the currently authorized trip.
 * @param {any} db @param {any} p @param {any} s */
export async function readVans(db, p, s) {
  const ids = s.ids.length ? s.ids : [null];
  const trips =
    await db`select t.*,v.name vehicle_name,v.vehicle_code,pe.name seller_name,
    (select sum(f.sales_centavos) from analytics_sales_facts f where f.route_session_id=t.route_session_id and f.service_date=t.service_date and f.agent_unit_id in ${db(ids)} and f.owner_unit_id in ${db(ids)} and (f.source_location_id is null or f.source_unit_id in ${db(ids)})) legacy_sales
    from van_trips t join vehicles v on v.id=t.vehicle_id join analytics_people pe on pe.id=t.salesperson_profile_id
    where t.deleted_at is null and t.status!='cancelled' and t.service_date between ${p.from} and ${p.to} and t.org_unit_id in ${db(ids)} and pe.current_unit_id in ${db(ids)}
    and (${s.ownProfileId}::uuid is null or pe.id=${s.ownProfileId}) and (${p.channel}::text is null or pe.channel_scope=${p.channel})`;
  const tripIds = trips.length
    ? trips.map((/** @type {any} */ t) => t.id)
    : [null];
  const [products, loads, events, counts, settlements, sales] =
    await Promise.all([
      readProducts(db),
      db`select l.trip_id,l.product_id,sum(l.actual_base) quantity from van_trip_load_lines l join van_trip_loads h on h.id=l.load_id where h.status='posted' and l.trip_id in ${db(tripIds)} and l.deleted_at is null group by l.trip_id,l.product_id`,
      db`select * from van_stock_events where trip_id in ${db(tripIds)}`,
      db`select c.trip_id,l.* from van_stock_count_lines l join van_stock_counts c on c.id=l.count_id where c.trip_id in ${db(tripIds)}`,
      db`select t.id trip_id,c.expected_centavos,c.declared_centavos,c.variance_centavos,r.amount_centavos remitted,
      (select sum(case when kind in ('refund','void_refund') then -amount_centavos else amount_centavos end) from van_payments where trip_id=t.id and method='cash') expected
      from van_trips t left join van_cash_counts c on c.trip_id=t.id left join van_cash_remittances r on r.trip_id=t.id where t.id in ${db(tripIds)}`,
      db`select s.trip_id,count(*) total,count(v.id) voids,coalesce(sum(s.total_centavos) filter(where v.id is null),0) sales,coalesce(sum(s.discount_centavos) filter(where v.id is null),0) discounts from van_sales s left join van_sale_voids v on v.sale_id=s.id where s.trip_id in ${db(tripIds)} group by s.trip_id`,
    ]);
  const casesFor = (
    /** @type {any[]} */ rows,
    /** @type {(row:any)=>number} */ quantity,
  ) => {
    if (!rows.length) return null;
    const values = rows.map((row) => {
      const product = products.find(
        (/** @type {any} */ pr) => pr.id === row.product_id,
      );
      const caseBase = Number(row.facts?.caseBase ?? product?.case_base ?? 0);
      return caseBase > 0 ? quantity(row) / caseBase : null;
    });
    return values.every((v) => v !== null)
      ? values.reduce((n, v) => n + Number(v), 0)
      : null;
  };
  return trips.map((/** @type {any} */ t) => {
    const own = events.filter((/** @type {any} */ e) => e.trip_id === t.id);
    const cash = settlements.find((/** @type {any} */ c) => c.trip_id === t.id);
    const sold = sales.find((/** @type {any} */ sale) => sale.trip_id === t.id);
    const counted = counts.filter((/** @type {any} */ c) => c.trip_id === t.id);
    const expected = num(
      cash?.expected ?? cash?.expected_centavos ?? (own.length ? 0 : null),
    );
    const remitted = num(cash?.remitted);
    const movementCases = (
      /** @type {string[]} */ kinds,
      /** @type {number} */ sign,
    ) => {
      const selected = own.filter((/** @type {any} */ e) =>
        kinds.includes(e.kind),
      );
      return selected.length
        ? casesFor(selected, (e) => sign * Number(e.delta_base))
        : own.length
          ? 0
          : null;
    };
    const state =
      t.status === "closed"
        ? "settled"
        : dateOf(t.service_date) < p.today || t.status === "review_required"
          ? "unclosed"
          : ["closing", "reconciling"].includes(t.status)
            ? "returned"
            : t.status === "active"
              ? "on_route"
              : "loading";
    return {
      tripId: t.id,
      truck: t.vehicle_name ?? t.vehicle_code,
      seller: t.seller_name,
      status: state,
      loadedCases: casesFor(
        loads.filter((/** @type {any} */ l) => l.trip_id === t.id),
        (l) => Number(l.quantity),
      ),
      soldCases: movementCases(["sale", "void"], -1),
      returnedCases: movementCases(["unload"], -1),
      customerReturnedCases: movementCases(["return"], 1),
      customerReturns: [
        ...new Set(
          own
            .filter((/** @type {any} */ e) => e.kind === "return")
            .map((/** @type {any} */ e) => e.product_id),
        ),
      ].map((productId) => {
        const returned = own.filter(
          (/** @type {any} */ e) =>
            e.kind === "return" && e.product_id === productId,
        );
        const facts = returned[0].facts;
        const product = products.find(
          (/** @type {any} */ p) => p.id === productId,
        );
        return {
          name: facts.name ?? product?.name ?? "Returned product",
          quantity: units(
            {
              quantity_scale: facts.quantityScale ?? product?.quantity_scale,
              case_base: facts.caseBase ?? product?.case_base,
              base_uom_code: facts.uomCode ?? product?.base_uom_code,
            },
            sum(returned, "delta_base"),
          ),
        };
      }),
      stockVarianceCases: counted.length
        ? casesFor(counted, (c) => Number(c.variance_base))
        : null,
      salesCentavos: sold ? Number(sold.sales) : Number(t.legacy_sales ?? 0),
      cashExpected: expected,
      cashRemitted: remitted,
      variance:
        expected !== null && remitted !== null ? remitted - expected : null,
      voids: Number(sold?.voids ?? 0),
      discountsCentavos: sold ? Number(sold.discounts) : own.length ? 0 : null,
      closedAt: ms(t.closed_at),
    };
  });
}
/** @param {any} db @param {any} p @param {any} s */
export async function vansPage(db, p, s) {
  const rows = await readVans(db, p, s),
    prior = await readVans(db, { ...p, ...p.compare }, s);
  return {
    kpis: [
      kpi(
        "tripsOut",
        "Trips out",
        rows.filter((/** @type {any} */ r) => r.status === "on_route").length,
        "count",
        null,
        prior.filter((/** @type {any} */ r) => r.status === "on_route").length,
        "Trips on route in the selected service dates.",
      ),
      kpi(
        "salesCentavos",
        "Van sales",
        sum(rows, "salesCentavos"),
        "php",
        null,
        sum(prior, "salesCentavos"),
        "Included order-line value linked to each trip’s route session.",
      ),
      ...[
        ["cashExpected", "Cash expected", "php"],
        ["cashRemitted", "Cash remitted", "php"],
        ["cashVariance", "Cash variance", "php"],
        ["stockVarianceCases", "Stock variance", "cases"],
      ].map(([key, label, unit]) =>
        kpi(
          key,
          label,
          knownSum(rows, key === "cashVariance" ? "variance" : key),
          unit,
          null,
          knownSum(prior, key === "cashVariance" ? "variance" : key),
          "Recorded settlement facts; unknown until a governed settlement ledger supplies them.",
        ),
      ),
    ],
    rows,
  };
}
/** @param {any} db @param {any} p @param {any} s */
export async function stockPage(db, p, s) {
  const ids = s.ids.length ? s.ids : [null];
  const [products, balances, locations, availability, sales, policies, lots] =
    await Promise.all([
      readProducts(db),
      db`select b.* from inventory_balances b join inventory_locations l on l.id=b.location_id where b.deleted_at is null and l.deleted_at is null and l.org_unit_id in ${db(ids)}`,
      db`select * from inventory_locations where deleted_at is null and active and org_unit_id in ${db(ids)}`,
      readAvailability(db, p, s),
      readSales(db, p, s, "sku"),
      db`select * from replenishment_policies where enabled and (location_id is null or location_id in(select id from inventory_locations where org_unit_id in ${db(ids)} and deleted_at is null))`,
      db`select b.*,l.expires_at from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id join inventory_locations x on x.id=b.location_id where x.org_unit_id in ${db(ids)} and b.physical_base>0`,
    ]);
  const avByProduct = new Map();
  for (const a of availability) {
    if (!avByProduct.has(a.product_id)) avByProduct.set(a.product_id, []);
    avByProduct.get(a.product_id).push(a);
  }
  const [universe] =
    await db`select count(*) as n from analytics_store_scope where status='active' and owner_unit_id in ${db(ids)} and (${p.channel}::text is null or channel=${p.channel})`;
  const distribution = await availabilityModel(db, p, s);
  const rows = [];
  for (const pr of products) {
    const bs = balances.filter(
        (/** @type {any} */ b) => b.product_id === pr.id,
      ),
      base = knownSum(bs, "physical_base"),
      onHand = units(pr, base),
      salesRow = sales.rows.find((/** @type {any} */ r) => r.key === pr.id);
    const caseBase =
      pr.case_base == null
        ? /^(case|cases|cs)$/i.test(pr.uom)
          ? Number(pr.quantity_scale ?? 1)
          : null
        : Number(pr.case_base);
    const soldCases =
      salesRow && caseBase
        ? /^(case|cases|cs)$/i.test(pr.uom)
          ? salesRow.quantity
          : (salesRow.quantity * Number(pr.quantity_scale ?? 1)) / caseBase
        : null;
    const avg = soldCases == null ? null : soldCases / p.days,
      daysCover =
        base === null || caseBase === null || !avg
          ? null
          : Math.round((base / caseBase / avg) * 10) / 10;
    const av = avByProduct.get(pr.id) ?? [];
    const policy = policies.filter(
      (/** @type {any} */ r) => r.product_id === pr.id,
    );
    const low = policy.length
      ? bs.some((/** @type {any} */ b) =>
          policy.some(
            (/** @type {any} */ r) =>
              (r.location_id === null || r.location_id === b.location_id) &&
              Number(b.available_base) < Number(r.reorder_point_base),
          ),
        )
      : null;
    rows.push({
      productId: pr.id,
      code: pr.code,
      name: pr.name,
      category: pr.category,
      onHand,
      valueCentavos: knownSum(bs, "inventory_value_minor"),
      avgDailySalesCases: avg === null ? null : Math.round(avg * 100) / 100,
      daysCover,
      numericDistributionPct:
        distribution.distribution.find(
          (/** @type {any} */ d) => d.productId === pr.id,
        )?.numericDistributionPct ?? null,
      weightedDistributionPct:
        distribution.distribution.find(
          (/** @type {any} */ d) => d.productId === pr.id,
        )?.weightedDistributionPct ?? null,
      buyingReachPct: pct(salesRow?.stores ?? 0, Number(universe.n)),
      unmeasuredStores:
        distribution.distribution.find(
          (/** @type {any} */ d) => d.productId === pr.id,
        )?.unmeasured ?? Number(universe.n),
      oosStores: av.length
        ? av.filter((/** @type {any} */ a) =>
            ["out_of_stock", "not_carried"].includes(a.status),
          ).length
        : null,
      status:
        base === null
          ? "unknown"
          : base <= 0
            ? "behind"
            : low === true
              ? "watch"
              : low === null
                ? "unknown"
                : "ok",
    });
  }
  const locRows = locations.map((/** @type {any} */ l) => {
    const bs = balances.filter(
        (/** @type {any} */ b) => b.location_id === l.id,
      ),
      us = bs.map((/** @type {any} */ b) => {
        const pr = products.find(
          (/** @type {any} */ p) => p.id === b.product_id,
        );
        return pr ? units(pr, num(b.physical_base)) : null;
      });
    return {
      locationId: l.id,
      label: l.name,
      kind:
        l.type === "truck"
          ? "truck"
          : l.type === "warehouse"
            ? "depot"
            : "other",
      valueCentavos: knownSum(bs, "inventory_value_minor"),
      cases:
        us.length && us.every((/** @type {any} */ u) => u?.cases != null)
          ? sum(us, "cases")
          : null,
    };
  });
  const depotIds = locations
    .filter((/** @type {any} */ l) => l.type === "warehouse")
    .map((/** @type {any} */ l) => l.id);
  const depot = balances.filter((/** @type {any} */ b) =>
    depotIds.includes(b.location_id),
  );
  const days = rows.filter((r) => r.daysCover !== null);
  return {
    kpis: [
      kpi(
        "stockValue",
        "Stock value",
        knownSum(balances, "inventory_value_minor"),
        "php",
        null,
        null,
        "Stored inventory cost value in centavos; unknown when any balance lacks cost.",
      ),
      kpi(
        "skusOutAtDepot",
        "SKUs out at depot",
        depot.length
          ? new Set(
              depot
                .filter(
                  (/** @type {any} */ b) => Number(b.available_base ?? 0) <= 0,
                )
                .map((/** @type {any} */ b) => b.product_id),
            ).size
          : null,
        "count",
        null,
        null,
        "Distinct depot products whose recorded available stock is zero or negative.",
      ),
      kpi(
        "lowStock",
        "Low stock",
        policies.length
          ? rows.filter((r) => r.status === "watch").length
          : null,
        "count",
        null,
        null,
        "Products below a configured replenishment point; no policy means unknown.",
      ),
      kpi(
        "daysCover",
        "Days of cover",
        days.length
          ? Math.round((sum(days, "daysCover") / days.length) * 10) / 10
          : null,
        "count",
        null,
        null,
        "Mean measurable stock cover in days at the selected period’s sales velocity.",
      ),
      kpi(
        "nearExpiry",
        "Near expiry",
        lots.filter(
          (/** @type {any} */ l) =>
            l.expires_at &&
            (ms(l.expires_at) ?? Infinity) <=
              Date.parse(p.to + "T23:59:59+08:00") + 30 * 86400000,
        ).length,
        "count",
        null,
        null,
        "Positive-stock lots expiring within 30 days of the selected date.",
      ),
      kpi(
        "badOrders",
        "Bad orders",
        knownSum(balances, "damaged_base"),
        "count",
        null,
        null,
        "Recorded damaged inventory in base units, not cases.",
      ),
    ],
    locations: locRows,
    rows,
  };
}
/** @param {any} db @param {any} p @param {any} s */
export async function moneyPage(db, p, s) {
  const [money, collections, mtd, prior] = await Promise.all([
    readMoney(db, p, s),
    readCollections(db, { ...p, from: p.to, to: p.to }, s),
    readCollections(db, { ...p, from: p.to.slice(0, 7) + "-01" }, s),
    readCollections(db, { ...p, ...p.compare }, s),
  ]);
  const aging = {
    current: knownSum(money.rows, "current"),
    d1_30: knownSum(money.rows, "d1_30"),
    d31_60: knownSum(money.rows, "d31_60"),
    d61_90: knownSum(money.rows, "d61_90"),
    d90p: knownSum(money.rows, "d90p"),
  };
  const overdue = money.rows.length
    ? sum(money.rows, "balance") - sum(money.rows, "current")
    : null;
  const held =
    await db`select count(distinct order_id) as n from analytics_sales_facts where status='review_required' and service_date between ${p.from} and ${p.to} and agent_unit_id in ${db(s.ids.length ? s.ids : [null])} and owner_unit_id in ${db(s.ids.length ? s.ids : [null])} and (source_location_id is null or source_unit_id in ${db(s.ids.length ? s.ids : [null])}) and (${s.ownProfileId}::uuid is null or profile_id=${s.ownProfileId}) and (${p.channel}::text is null or channel=${p.channel})`;
  return {
    demo: money.demo,
    kpis: [
      kpi(
        "collectionsToday",
        "Collections today",
        sum(collections, "amount_minor"),
        "php",
        null,
        sum(prior, "amount_minor"),
        "Field collections plus net non-credit van payments on the final selected Manila date; cashier hand-in is not counted twice.",
      ),
      kpi(
        "collectionsMtd",
        "Collections month to date",
        sum(mtd, "amount_minor"),
        "php",
        null,
        null,
        "Field collections plus net non-credit van payments from month start through the selected date.",
      ),
      kpi(
        "arTotal",
        "Accounts receivable",
        knownSum(money.rows, "balance"),
        "php",
        null,
        null,
        "Office aging less field collections, plus unposted van credit less collections against those exact invoices.",
      ),
      kpi(
        "overdue",
        "Overdue receivables",
        overdue,
        "php",
        null,
        null,
        "Remaining aging buckets beyond current; absent AR feed is unknown.",
      ),
      kpi(
        "creditBreaches",
        "Credit breaches",
        money.rows.length
          ? money.rows.filter(
              (/** @type {any} */ r) =>
                r.creditLimit > 0 && r.balance > r.creditLimit,
            ).length
          : null,
        "count",
        null,
        null,
        "Accounts with a known credit limit below their recorded receivable balance.",
      ),
      kpi(
        "heldOrders",
        "Held orders",
        Number(held[0].n),
        "count",
        null,
        null,
        "Orders explicitly marked review required within this period.",
      ),
    ],
    aging,
    rows: money.rows,
  };
}
