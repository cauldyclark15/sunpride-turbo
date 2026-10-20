import {
  kpi,
  pct,
  delta,
  status,
  sum,
  dates,
  addDays,
  monthEnd,
  dateOf,
  ms,
  minTime,
  maxTime,
  daysBetween,
  monthlyPace,
} from "./measures.js";
import { readSales } from "./measures.js";
import { targetBook, targetFor } from "./targets.js";
import {
  readPeople,
  readVisits,
  visitSummary,
  readCollections,
} from "./data.js";
import { readVans } from "./stock-money.js";
import { exceptionsFor } from "./exceptions.js";
import { ApiError } from "../../core/errors.js";
import { sliceTiles } from "./tiles.js";
import { availabilityModel } from "./availability-adapter.js";

/** @param {any} db @param {any} p @param {any} s @param {string} [group] @param {string|null} [parent] */
export async function salesPage(db, p, s, group = "channel", parent = null) {
  const [current, prior] = await Promise.all([
    readSales(db, p, s, group, parent),
    readSales(db, { ...p, ...p.compare }, s, group, parent),
  ]);
  // A drill keeps the same filter in totals, trend and target.
  const parentParts = parent?.split(":");
  const level =
    parentParts && ["agent", "territory", "channel"].includes(parentParts[0])
      ? parentParts[0]
      : p.channel
        ? "channel"
        : "company";
  const target = await targetFor(
    db,
    s,
    p,
    level,
    parentParts?.[1] ?? p.channel ?? "company",
  );
  const t = current.total,
    pt = prior.total;
  const elapsed = { ...p, to: p.today < p.to ? p.today : p.to };
  const due =
    elapsed.to >= p.from
      ? await targetFor(
          db,
          s,
          elapsed,
          level,
          parentParts?.[1] ?? p.channel ?? "company",
        )
      : 0;
  const month = {
    ...p,
    from: p.to.slice(0, 7) + "-01",
    to: monthEnd(p.to.slice(0, 7)),
  };
  const monthlyTarget = await targetFor(
    db,
    s,
    month,
    level,
    parentParts?.[1] ?? p.channel ?? "company",
  );
  // Month to date through the selected date. When the selected period already covers
  // that range, sum its additive daily rows instead of reading the same sales twice.
  const monthSalesTotal =
    p.from <= month.from
      ? current.days
          .filter(
            (/** @type {any} */ d) => d.key >= month.from && d.key <= p.to,
          )
          .reduce(
            (/** @type {number} */ n, /** @type {any} */ d) => n + d.sales,
            0,
          )
      : (await readSales(db, { ...month, to: p.to }, s, group, parent)).total
          .sales;
  const { balance, perDay } = monthlyPace(monthlyTarget, monthSalesTotal, p.to);
  const kpis = [
    kpi(
      "sales",
      "Sales",
      t.sales,
      "php",
      due,
      pt.sales,
      "Net order-line value excluding draft, rejected and voided orders, on the Manila order date.",
    ),
    kpi(
      "target",
      "Target for selected period",
      target,
      "php",
      null,
      null,
      "Monthly targets phased across Monday to Saturday selling days.",
    ),
    kpi(
      "attainment",
      "Attainment",
      pct(t.sales, target),
      "pct",
      100,
      pct(pt.sales, target),
      "Net sales divided by the target for this period.",
    ),
    kpi(
      "balanceToSell",
      "Balance to sell this month",
      balance,
      "php",
      null,
      null,
      "Full monthly target less month-to-date net sales through the selected date, floored at zero.",
    ),
    kpi(
      "perDayNeeded",
      "Needed each selling day this month",
      perDay,
      "php",
      null,
      null,
      "Monthly balance divided by Monday to Saturday selling days after the selected date, rounded up to a centavo.",
    ),
    kpi(
      "orders",
      "Orders",
      t.orders,
      "count",
      null,
      pt.orders,
      "Distinct included orders, counted once even when they contain several SKUs.",
    ),
    kpi(
      "dropSize",
      "Drop size",
      t.orders ? Math.round(t.sales / t.orders) : null,
      "php",
      null,
      pt.orders ? Math.round(pt.sales / pt.orders) : null,
      "Net sales divided by the number of included orders.",
    ),
    kpi(
      "linesPerOrder",
      "Lines per order",
      t.orders ? Math.round((t.lines / t.orders) * 10) / 10 : null,
      "count",
      null,
      pt.orders ? Math.round((pt.lines / pt.orders) * 10) / 10 : null,
      "Included source lines divided by distinct orders.",
    ),
    kpi(
      "ubo",
      "Unique buying accounts",
      t.ubo,
      "count",
      null,
      pt.ubo,
      "Distinct accounting customer codes with a positive sale in the period.",
    ),
  ];
  const rows = [];
  for (const r of current.rows) {
    const previous = prior.rows.find((/** @type {any} */ x) => x.key === r.key);
    const rt = ["channel", "territory", "agent"].includes(group)
      ? await targetFor(db, s, p, group, r.key)
      : null;
    const dueRow =
      ["channel", "territory", "agent"].includes(group) && elapsed.to >= p.from
        ? await targetFor(db, s, elapsed, group, r.key)
        : null;
    const next = /** @type {Record<string,string|null>} */ ({
      channel: "territory",
      territory: "agent",
      agent: "store",
      category: "sku",
      sku: null,
      store: null,
    })[group];
    rows.push({
      key: r.key,
      label: r.label,
      sales: r.sales,
      target: rt,
      attainmentPct: pct(r.sales, rt),
      prior: previous?.sales ?? 0,
      deltaPct: delta(r.sales, previous?.sales ?? 0),
      orders: r.orders,
      dropSize: r.orders ? Math.round(r.sales / r.orders) : null,
      ubo: r.ubo,
      status: status(r.sales, dueRow),
      drill: next ? { groupBy: next, parent: `${group}:${r.key}` } : null,
    });
  }
  let cumSales = 0,
    cumPrior = 0,
    cumTarget = 0;
  const trend = [];
  for (const d of dates(p.from, p.to)) {
    const index = daysBetween(p.from, d),
      pd = addDays(p.compare.from, index),
      sales =
        current.days.find((/** @type {any} */ x) => x.key === d)?.sales ?? 0;
    cumSales += sales;
    cumPrior +=
      prior.days.find((/** @type {any} */ x) => x.key === pd)?.sales ?? 0;
    const dailyTarget = await targetFor(
      db,
      s,
      { ...p, from: d, to: d },
      level,
      parentParts?.[1] ?? p.channel ?? "company",
    );
    cumTarget += dailyTarget ?? 0;
    trend.push({
      date: d,
      sales,
      cumSales,
      cumTarget: target === null ? null : cumTarget,
      cumPrior,
    });
  }
  return {
    kpis,
    stages: { booked: t.sales, approved: t.approved, posted: t.posted },
    trend,
    rows: rows.sort((a, b) => b.sales - a.sales),
  };
}

/** @param {any} ctx @param {any} p @param {any} s */
export async function todayPage(ctx, p, s) {
  const db = ctx.db,
    monthP = {
      ...p,
      from: p.to.slice(0, 7) + "-01",
      to: monthEnd(p.to.slice(0, 7)),
    };
  const mtd = { ...p, from: monthP.from };
  const trendPeriod = { ...p, from: addDays(p.to, -13) };
  const overview = await readSales(
    db,
    {
      ...p,
      from: monthP.from < trendPeriod.from ? monthP.from : trendPeriod.from,
    },
    s,
  );
  const [
    daySales,
    mtdSales,
    people,
    facts,
    collections,
    vans,
    target,
    monthTarget,
    trendSales,
  ] = await Promise.all([
    overview.agentDays ? sliceTiles(overview, p) : readSales(db, p, s),
    overview.agentDays ? sliceTiles(overview, mtd) : readSales(db, mtd, s),
    readPeople(db, s, p.channel),
    readVisits(db, p, s),
    readCollections(db, p, s),
    readVans(db, p, s),
    targetFor(
      db,
      s,
      p,
      p.channel ? "channel" : "company",
      p.channel ?? "company",
    ),
    targetFor(
      db,
      s,
      monthP,
      p.channel ? "channel" : "company",
      p.channel ?? "company",
    ),
    overview.agentDays
      ? sliceTiles(overview, trendPeriod)
      : readSales(db, trendPeriod, s),
  ]);
  const summary = visitSummary(facts),
    byAgent = overview.agentDays
      ? sliceTiles(overview, p, "agent")
      : await readSales(db, p, s, "agent");
  const exceptions = await exceptionsFor(ctx, p, s, {
    people,
    facts,
    sales: byAgent,
    vans,
    topOnly: true,
  });
  const { balance, perDay } = monthlyPace(
    monthTarget,
    mtdSales.total.sales,
    p.to,
  );
  const prior =
    overview.agentDays && p.compare.from >= overview.days[0]?.key
      ? sliceTiles(overview, { ...p, ...p.compare })
      : await readSales(db, { ...p, ...p.compare }, s);
  const fieldPeople = people.filter(
    (/** @type {any} */ r) =>
      r.role === "sales" ||
      facts.planned.some(
        (/** @type {any} */ v) => v.assignee_profile_id === r.id,
      ),
  );
  const fieldRows = fieldPeople.map((/** @type {any} */ person) => {
    const planned = facts.planned.filter(
        (/** @type {any} */ r) => r.assignee_profile_id === person.id,
      ),
      visits = facts.visits.filter(
        (/** @type {any} */ r) => r.assignee_profile_id === person.id,
      );
    const v = visitSummary({ planned, visits, coaching: [] }),
      open = visits.some((/** @type {any} */ r) =>
        ["arrived", "checked-in", "in-progress"].includes(r.state),
      );
    const last = maxTime(visits, "last_server_time");
    const status = !planned.length
      ? "no_plan"
      : !visits.length
        ? "not_started"
        : open
          ? "in_call"
          : v.visited >= v.planned
            ? "done"
            : last !== null && ctx.now - last > 60 * 60_000
              ? "idle"
              : "not_started";
    return {
      profileId: person.id,
      name: person.name,
      territory: person.territory_name ?? null,
      status,
      lastSeenAt: last,
      planned: v.planned,
      visited: v.visited,
      productive: v.productive,
      sales:
        byAgent.rows.find((/** @type {any} */ r) => r.key === person.id)
          ?.sales ?? 0,
    };
  });
  const counts = { noPlan: 0, notStarted: 0, inCall: 0, done: 0, idle: 0 };
  const map = /** @type {Record<string,keyof typeof counts>} */ ({
    no_plan: "noPlan",
    not_started: "notStarted",
    in_call: "inCall",
    done: "done",
    idle: "idle",
  });
  for (const r of fieldRows) counts[map[r.status]]++;
  const byChannel = [];
  for (const r of daySales.rows) {
    const target = await targetFor(db, s, p, "channel", r.key);
    byChannel.push({
      channel: r.key,
      label: r.label,
      sales: r.sales,
      target,
      attainmentPct: pct(r.sales, target),
      status: status(r.sales, target),
    });
  }
  const trend = [];
  for (const d of dates(addDays(p.to, -13), p.to))
    trend.push({
      date: d,
      sales:
        trendSales.days.find((/** @type {any} */ r) => r.key === d)?.sales ?? 0,
      target: await targetFor(
        db,
        s,
        { ...p, from: d, to: d },
        p.channel ? "channel" : "company",
        p.channel ?? "company",
      ),
    });
  return {
    kpis: [
      kpi(
        "salesToday",
        "Sales today",
        daySales.total.sales,
        "php",
        target,
        prior.total.sales,
        "Net included order lines on this Manila date.",
      ),
      kpi(
        "mtdSales",
        "Month to date sales",
        mtdSales.total.sales,
        "php",
        await targetFor(
          db,
          s,
          mtd,
          p.channel ? "channel" : "company",
          p.channel ?? "company",
        ),
        null,
        "The same sales definition from the first day of this month through this date.",
      ),
      kpi(
        "balanceToSell",
        "Balance to sell this month",
        balance,
        "php",
        null,
        null,
        "Full monthly target less month-to-date net sales, floored at zero.",
      ),
      kpi(
        "perDayNeeded",
        "Needed each selling day this month",
        perDay,
        "php",
        null,
        null,
        "Monthly balance divided by selling days remaining after this date.",
      ),
      kpi(
        "coverage",
        "Coverage",
        summary.compliance,
        "pct",
        100,
        null,
        "Distinct completed planned stops divided by active planned stops.",
      ),
      kpi(
        "productiveCalls",
        "Productive calls",
        summary.productive,
        "count",
        null,
        null,
        "Completed planned calls judged productive by the governed visit rule.",
      ),
      kpi(
        "collectionsToday",
        "Collections today",
        sum(collections, "amount_minor"),
        "php",
        null,
        null,
        "Non-rejected field collections dated by Manila device time.",
      ),
      kpi(
        "vansOut",
        "Vans out",
        vans.filter((/** @type {any} */ r) => r.status === "on_route").length,
        "count",
        null,
        null,
        "Trips currently on route on the selected day.",
      ),
    ],
    byChannel,
    field: { counts, people: fieldRows },
    vans: vans.map((/** @type {any} */ r) => ({
      tripId: r.tripId,
      truck: r.truck,
      seller: r.seller,
      status: r.status,
      salesCentavos: r.salesCentavos,
      cashExpected: r.cashExpected,
      cashRemitted: r.cashRemitted,
      variance: r.variance,
    })),
    exceptions: exceptions.slice(0, 5),
    trend,
  };
}

/** @param {any} db @param {any} p @param {any} s @param {string} group */
export async function coveragePage(db, p, s, group) {
  if (!["agent", "territory"].includes(group))
    throw new ApiError("invalid_group", 400, "Choose agent or territory");
  const [facts, people, sales, priorFacts, availability, priorAvailability] =
    await Promise.all([
      readVisits(db, p, s),
      readPeople(db, s, p.channel),
      readSales(db, p, s, "agent"),
      readVisits(db, { ...p, ...p.compare }, s),
      availabilityModel(db, p, s),
      availabilityModel(db, { ...p, ...p.compare }, s),
    ]);
  const all = visitSummary(facts),
    before = visitSummary(priorFacts);
  const weekStart = (/** @type {string} */ d) =>
    addDays(d, -((new Date(d).getUTCDay() + 6) % 7));
  const weeks = [...new Set(dates(p.from, p.to).map(weekStart))].map(
    (weekStart) => ({ weekStart }),
  );
  const weekByRow = new Map(
    [...facts.planned, ...facts.visits].map((/** @type {any} */ row) => [
      row,
      weekStart(dateOf(row.service_date)),
    ]),
  );
  const groups = new Map();
  for (const person of people) {
    if (
      person.role !== "sales" &&
      !facts.planned.some(
        (/** @type {any} */ r) => r.assignee_profile_id === person.id,
      ) &&
      !facts.coaching.some(
        (/** @type {any} */ r) => r.trainer_profile_id === person.id,
      )
    )
      continue;
    const key =
      group === "agent" ? person.id : (person.territory_id ?? "unassigned");
    if (!groups.has(key))
      groups.set(key, {
        key,
        label:
          group === "agent"
            ? person.name
            : (person.territory_name ?? "Unassigned"),
        ids: [],
        required: 0,
        requiredKnown: true,
      });
    const g = groups.get(key);
    g.ids.push(person.id);
    const required = person.work_with_weekly_min;
    if (required == null) g.requiredKnown = false;
    else g.required += Number(required) * weeks.length;
  }
  const rows = [];
  for (const g of groups.values()) {
    const selected = {
      planned: facts.planned.filter((/** @type {any} */ r) =>
        g.ids.includes(r.assignee_profile_id),
      ),
      visits: facts.visits.filter((/** @type {any} */ r) =>
        g.ids.includes(r.assignee_profile_id),
      ),
      coaching: facts.coaching.filter((/** @type {any} */ r) =>
        g.ids.includes(r.trainer_profile_id),
      ),
    };
    const a = visitSummary(selected),
      lines = sum(
        sales.rows.filter((/** @type {any} */ r) => g.ids.includes(r.key)),
        "lines",
      );
    rows.push({
      key: g.key,
      label: g.label,
      planned: a.planned,
      visited: a.visited,
      compliancePct: a.compliance,
      missed: a.missed,
      offPlan: a.offPlan,
      productive: a.productive,
      productiveRatePct: a.productiveRate,
      orderCalls: a.orderCalls,
      strikeRatePct: a.strikeRate,
      productiveCallPct: a.productivePct,
      distributionGained: stockingGain(
        availability.observations,
        priorAvailability.observations,
        g.ids,
      ),
      dwellMin: a.dwellMin,
      completedCalls: a.completedCalls,
      dropSize: (() => {
        const rs = sales.rows.filter((/** @type {any} */ r) =>
          g.ids.includes(r.key),
        );
        const n = sum(rs, "orders");
        return n ? Math.round(sum(rs, "sales") / n) : null;
      })(),
      linesPerCall: a.completedCalls
        ? Math.round((a.callLines / a.completedCalls) * 10) / 10
        : null,
      firstCallAt: a.first,
      lastCallAt: a.last,
      timeInMarketMin: a.time,
      workWith: {
        done: a.workWith,
        required: g.requiredKnown ? g.required : null,
      },
      weekly: weeks.map(
        (w) =>
          visitSummary({
            planned: selected.planned.filter(
              (/** @type {any} */ r) => weekByRow.get(r) === w.weekStart,
            ),
            visits: selected.visits.filter(
              (/** @type {any} */ r) => weekByRow.get(r) === w.weekStart,
            ),
            coaching: [],
          }).compliance,
      ),
      status: status(a.compliance, 100),
    });
  }
  return {
    kpis: [
      kpi(
        "compliance",
        "MCP compliance",
        all.compliance,
        "pct",
        100,
        before.compliance,
        "Distinct completed active planned stops divided by all active planned stops.",
      ),
      kpi(
        "missedStops",
        "Missed stops",
        all.missed,
        "count",
        null,
        before.missed,
        "Active planned stops without a completed execution in this period.",
      ),
      kpi(
        "offPlanVisits",
        "Off-plan visits",
        all.offPlan,
        "count",
        null,
        before.offPlan,
        "Executions without an active signed planned stop; these do not earn a planned call.",
      ),
      kpi(
        "productiveRate",
        "Productive calls",
        all.productiveRate,
        "pct",
        null,
        before.productiveRate,
        "Each visit uses its frozen definition when available; older visits use provisional historical standards. This is separate from calls with a linked order.",
      ),
      kpi(
        "strikeRate",
        "Order strike rate",
        all.strikeRate,
        "pct",
        null,
        before.strikeRate,
        "Completed calls with an accepted call-linked order divided by all completed calls, including off-plan calls. Productive-call percentage is separate.",
      ),
      kpi(
        "linesPerCall",
        "Lines per call",
        all.completedCalls
          ? Math.round((all.callLines / all.completedCalls) * 10) / 10
          : null,
        "count",
        null,
        null,
        "Accepted call-linked order lines divided by all completed calls.",
      ),
      kpi(
        "timeInMarket",
        "Time in market",
        rows.some((r) => r.timeInMarketMin !== null)
          ? sum(rows, "timeInMarketMin")
          : null,
        "minutes",
        null,
        null,
        "Sum of each person’s first-start to last-end spans over the period.",
      ),
      kpi(
        "workWithDone",
        "Work-With completed",
        all.workWith,
        "count",
        null,
        before.workWith,
        "Completed coaching sessions dated by their service day.",
      ),
    ],
    productivityTrend: weeks.map((w) => {
      const summary = visitSummary({
        planned: facts.planned.filter(
          (/** @type {any} */ r) => weekByRow.get(r) === w.weekStart,
        ),
        visits: facts.visits.filter(
          (/** @type {any} */ r) => weekByRow.get(r) === w.weekStart,
        ),
        coaching: [],
      });
      return {
        date: w.weekStart,
        strikeRatePct: summary.strikeRate,
        productiveCallPct: summary.productivePct,
        dwellMin: summary.dwellMin,
      };
    }),
    productivity: {
      productiveCallPct: all.productivePct,
      priorProductiveCallPct: before.productivePct,
      dwellMin: all.dwellMin,
      priorDwellMin: before.dwellMin,
      orderCalls: all.orderCalls,
      completedCalls: all.completedCalls,
      definitionVersion: "commercial/v1",
    },
    weeks,
    rows: rows
      .sort(
        (a, b) =>
          (b.strikeRatePct ?? -1) - (a.strikeRatePct ?? -1) ||
          a.label.localeCompare(b.label),
      )
      .map((r, i) => ({ ...r, rank: r.strikeRatePct === null ? null : i + 1 })),
  };
}

/** F-605 matched fresh observations only; unmeasured is never a gained/lost stocking point.
 * @param {any[]} current @param {any[]} prior @param {string[]} profileIds */
function stockingGain(current, prior, profileIds) {
  const before = new Map(
    prior.map((r) => [`${r.outlet_id}:${r.product_id}`, r]),
  );
  const pairs = current.filter(
    (r) =>
      profileIds.includes(r.assignee_profile_id) &&
      before.has(`${r.outlet_id}:${r.product_id}`),
  );
  const present = (/** @type {any} */ r) =>
    ["available", "low_stock"].includes(r.status);
  return pairs.length
    ? pairs.reduce(
        (n, r) =>
          n +
          Number(present(r)) -
          Number(present(before.get(`${r.outlet_id}:${r.product_id}`))),
        0,
      )
    : null;
}

/** @param {any} ctx @param {any} p @param {any} s */
export async function agentDayPage(ctx, p, s) {
  const id = ctx.url.searchParams.get("profileId"),
    people = await readPeople(ctx.db, s, p.channel),
    person = people.find((/** @type {any} */ r) => r.id === id);
  if (!person)
    throw new ApiError("out_of_scope", 403, "This person is outside your team");
  const own = { ...s, ownProfileId: id },
    facts = await readVisits(ctx.db, p, own),
    summary = visitSummary(facts);
  const [sales, collections, trail] = await Promise.all([
    readSales(ctx.db, p, own),
    readCollections(ctx.db, p, own),
    ctx.actor.capabilities.has("location.read")
      ? ctx.db`select recorded_at as at,latitude as lat,longitude as lng from location_pings where profile_id=${id} and service_date=${p.to} and org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} and deleted_at is null and not mock_location order by recorded_at`
      : [],
  ]);
  const timeline = [];
  for (const v of facts.visits) {
    const base = {
      storeId: v.outlet_id,
      storeLabel: v.store_name,
      amountCentavos: null,
      onPlan: v.onPlan,
    };
    const start = ms(v.started_at) ?? ms(v.checked_in_at),
      end = ms(v.ended_at) ?? ms(v.checked_out_at);
    if (start !== null)
      timeline.push({
        ...base,
        at: start,
        kind: "check_in",
        detail: "Visit started",
      });
    if (end !== null)
      timeline.push({
        ...base,
        at: end,
        kind: "check_out",
        detail: "Visit closed",
      });
    for (const a of v.activities)
      timeline.push({
        ...base,
        at: Number(a.deviceTime),
        kind: "activity",
        detail: String(a.kind).replaceAll("_", " "),
      });
  }
  for (const c of collections) {
    const v = facts.visits.find((/** @type {any} */ v) => v.id === c.visit_id);
    timeline.push({
      at: ms(c.device_time),
      kind: "collection",
      storeId: c.outlet_id,
      storeLabel: v?.store_name ?? "Store",
      detail: "Collection recorded",
      amountCentavos: Number(c.amount_minor),
      onPlan: v?.onPlan ?? false,
    });
  }
  const orders =
    await ctx.db`select f.order_id,f.store_id,max(f.store_name) as name,min(f.created_at) as at,sum(f.sales_centavos) as amount from analytics_sales_facts f where f.profile_id=${id} and f.service_date=${p.to} and f.agent_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} and f.owner_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} and (f.source_location_id is null or f.source_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])}) and (${p.channel}::text is null or f.channel=${p.channel}) group by f.order_id,f.store_id`;
  for (const o of orders)
    timeline.push({
      at: ms(o.at),
      kind: "order",
      storeId: o.store_id,
      storeLabel: o.name,
      detail: "Order recorded",
      amountCentavos: Number(o.amount),
      onPlan: facts.planned.some(
        (/** @type {any} */ v) => v.outlet_id === o.store_id,
      ),
    });
  let distance = 0;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1],
      b = trail[i],
      rad = Math.PI / 180;
    const h =
      Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) *
        Math.cos(b.lat * rad) *
        Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
    distance += 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  return {
    person: {
      profileId: id,
      name: person.name,
      territory: person.territory_name ?? null,
      position: person.position_label ?? null,
    },
    summary: {
      planned: summary.planned,
      visited: summary.visited,
      productive: summary.productive,
      sales: sales.total.sales,
      firstCallAt: summary.first,
      lastCallAt: summary.last,
      distanceKm: trail.length > 1 ? Math.round(distance * 10) / 10 : null,
    },
    timeline: timeline.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    trail: trail.map((/** @type {any} */ r) => ({ ...r, at: ms(r.at) })),
  };
}
