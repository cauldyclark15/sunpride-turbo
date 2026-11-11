import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import {
  assertHeader,
  assertKpis,
  assertException,
  keys,
} from "./analytics-schema.js";
import {
  sellingDays,
  prorate,
  status,
  dateOf,
  addDays,
  csv,
} from "../src/domains/analytics/measures.js";
import { suggestLine } from "../src/domains/analytics/suggested-order.js";
import {
  rebuildDay,
  enqueueRefresh,
  fullRebuild,
  installRefresh,
} from "../src/domains/analytics/refresh.js";
import { visitSummary } from "../src/domains/analytics/data.js";

// VISITS owns this named seam. Deliberately distinguish a note-only completion.
mock.module("../src/domains/visits/productive.js", () => ({
  isProductive: (/** @type {any} */ facts) => ({
    productive: facts.activityKinds.includes("merchandising"),
    reason: "fixture governed rule",
  }),
}));
const { install } = await import("../src/domains/analytics/index.js");
/** @type {any} */ let h;
/** @type {any} */ let f;
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  f = await analyticsFixture(h);
}, 120000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} path */
async function get(path) {
  const res = await f.get(path);
  const b = await res.json();
  expect(res.status, JSON.stringify(b)).toBe(200);
  return /** @type {any} */ (b);
}
/** @param {string} page @param {string} [query] */
const url = (page, query = "") =>
  `/api/v1/analytics/${page}?from=${f.start}&to=${f.today}&${query}`;

const contracts = /** @type {Record<string,string[]>} */ ({
  today: [
    "salesToday",
    "mtdSales",
    "balanceToSell",
    "perDayNeeded",
    "coverage",
    "productiveCalls",
    "collectionsToday",
    "vansOut",
  ],
  sales: [
    "sales",
    "target",
    "attainment",
    "balanceToSell",
    "perDayNeeded",
    "orders",
    "dropSize",
    "linesPerOrder",
    "ubo",
  ],
  coverage: [
    "compliance",
    "missedStops",
    "offPlanVisits",

    "productiveRate",
    "timeInMarket",
    "workWithDone",
    "strikeRate",
    "linesPerCall",
    "validatedUniverse",
    "coveredUniverse",
    "billedUniverse",
    "frequencyAchieved",
    "numericDistribution",
    "weightedDistribution",
    "osa",
    "osaCompleteness",
  ],
  stores: [
    "universe",
    "activeBuying",
    "ubo",
    "newStores",
    "lostStores",
    "dormant",
  ],
  store: [
    "salesPeriod",
    "visitsPeriod",
    "avgDrop",
    "skuCount",
    "osa",
    "arBalance",
  ],
  stock: [
    "stockValue",
    "skusOutAtDepot",
    "lowStock",
    "daysCover",
    "nearExpiry",
    "badOrders",
  ],
  vans: [
    "tripsOut",
    "salesCentavos",
    "cashExpected",
    "cashRemitted",
    "cashVariance",
    "stockVarianceCases",
  ],
  money: [
    "collectionsToday",
    "collectionsMtd",
    "arTotal",
    "overdue",
    "creditBreaches",
    "heldOrders",
  ],
});
for (const [page, kpis] of Object.entries(contracts))
  test(`${page}: exact header and KPI wire schema`, async () => {
    const r = await get(url(page, `date=${f.today}&storeId=${f.store}`));
    assertHeader(r);
    assertKpis(r, kpis);
    if (page === "today") {
      keys(r, ["byChannel", "field", "vans", "exceptions", "trend"]);
      keys(r.field.counts, ["noPlan", "notStarted", "inCall", "done", "idle"]);
      expect(r.trend).toHaveLength(14);
      for (const e of r.exceptions) assertException(e);
      expect(r.exceptions.length).toBeLessThanOrEqual(5);
    }
    if (page === "sales") {
      keys(r.stages, ["booked", "approved", "posted"]);
      for (const row of r.rows)
        keys(row, [
          "key",
          "label",
          "sales",
          "target",
          "attainmentPct",
          "prior",
          "deltaPct",
          "orders",
          "dropSize",
          "ubo",
          "status",
          "drill",
        ]);
    }
    if (page === "coverage")
      for (const row of r.rows) {
        keys(row, [
          "key",
          "label",
          "planned",
          "visited",
          "compliancePct",
          "missed",
          "offPlan",
          "productive",
          "productiveRatePct",
          "orderCalls",
          "strikeRatePct",
          "linesPerCall",
          "firstCallAt",
          "lastCallAt",
          "timeInMarketMin",
          "workWith",
          "weekly",
          "status",
        ]);
        expect(row.weekly).toHaveLength(r.weeks.length);
      }
    if (page === "stores")
      for (const row of r.rows)
        keys(row, [
          "storeId",
          "code",
          "name",
          "channel",
          "territory",
          "status",
          "salesPeriod",
          "salesPrior",
          "deltaPct",
          "lastOrderAt",
          "lastVisitAt",
          "skuCount",
          "mustSellGaps",
          "arBalance",
        ]);
    if (page === "stock")
      for (const row of r.rows)
        keys(row, [
          "productId",
          "code",
          "name",
          "category",
          "onHand",
          "valueCentavos",
          "avgDailySalesCases",
          "daysCover",
          "buyingReachPct",
          "oosStores",
          "status",
        ]);
    if (page === "store")
      keys(r, [
        "store",
        "salesTrend",
        "visits",
        "orders",
        "assortment",
        "suggestedOrder",
      ]);
  }, 60000);

test("agent-day schema and governed call evidence", async () => {
  const r = await get(url("agent-day", `profileId=${f.agent}&date=${f.today}`));
  assertHeader(r);
  keys(r.person, ["profileId", "name", "territory", "position"]);
  keys(r.summary, [
    "planned",
    "visited",
    "productive",
    "sales",
    "firstCallAt",
    "lastCallAt",
    "distanceKm",
  ]);
  expect(r.summary.productive).toBe(1);
  expect(r.summary.planned).toBe(1);
  for (const t of r.timeline)
    keys(t, [
      "at",
      "kind",
      "storeId",
      "storeLabel",
      "detail",
      "amountCentavos",
      "onPlan",
    ]);
});
test("exceptions schema, every kind has a count, actionable workflow paths", async () => {
  const r = await get(url("exceptions"));
  assertHeader(r);
  // F-210 adds the persisted cycle-based "dormant_store" kind beside the period insight.
  expect(Object.keys(r.counts)).toHaveLength(17);
  for (const e of r.items) assertException(e);
  expect(
    r.items.some((/** @type {any} */ e) => e.kind === "order_approval"),
  ).toBe(true);
});
test("sales definitions reconcile Today, day agent rows and channel rows to the centavo", async () => {
  const today = await get(url("today", `date=${f.today}`)),
    agent = await get(
      `/api/v1/analytics/sales?from=${f.today}&to=${f.today}&groupBy=agent`,
    ),
    channel = await get(
      `/api/v1/analytics/sales?from=${f.today}&to=${f.today}&groupBy=channel`,
    );
  const total = (/** @type {any[]} */ r) => r.reduce((n, r) => n + r.sales, 0),
    value = today.kpis.find(
      (/** @type {any} */ k) => k.key === "salesToday",
    ).value;
  expect(value).toBe(300 * 10636);
  expect(value).toBe(total(agent.rows));
  expect(value).toBe(total(channel.rows));
  expect(value).toBe(total(today.byChannel));
  const mtd = await get(
    `/api/v1/analytics/sales?from=${f.today.slice(0, 7)}-01&to=${f.today}&groupBy=agent`,
  );
  expect(
    today.kpis.find((/** @type {any} */ k) => k.key === "mtdSales").value,
  ).toBe(total(mtd.rows));
  const mtdChannels = await get(
    `/api/v1/analytics/sales?from=${f.today.slice(0, 7)}-01&to=${f.today}&groupBy=channel`,
  );
  expect(total(mtd.rows)).toBe(total(mtdChannels.rows));
});
test("all six groupings reconcile sales; shared order counted only once in the headline", async () => {
  for (const group of [
    "channel",
    "territory",
    "agent",
    "category",
    "sku",
    "store",
  ]) {
    const r = await get(url("sales", `groupBy=${group}`));
    expect(
      r.rows.reduce(
        (/** @type {number} */ n, /** @type {any} */ r) => n + r.sales,
        0,
      ),
    ).toBe(r.kpis[0].value);
    expect(
      r.kpis.find((/** @type {any} */ k) => k.key === "orders").value,
    ).toBe(900);
    expect(r.trend[r.trend.length - 1].cumSales).toBe(r.kpis[0].value);
  }
});
test("Today and Sales share full-month balance and selling-day pace, and a target never grades itself", async () => {
  expect(
    (
      await f.post("/api/v1/targets/set", {
        month: f.today.slice(0, 7),
        level: "company",
        key: "company",
        amountCentavos: 900_000_000,
      })
    ).status,
  ).toBe(200);
  const today = await get(url("today", `date=${f.today}`));
  const sales = await get(url("sales"));
  for (const key of ["balanceToSell", "perDayNeeded"]) {
    const a = today.kpis.find((/** @type {any} */ k) => k.key === key);
    const b = sales.kpis.find((/** @type {any} */ k) => k.key === key);
    expect(b.value, key).toBe(a.value);
    expect(b.label).toContain("month");
  }
  const target = sales.kpis.find((/** @type {any} */ k) => k.key === "target");
  expect(target.target).toBeNull();
  expect(target.status).toBe("unknown");
  await h.db`delete from analytics_target_events`;
  await h.db`delete from sales_targets`;
});

test("no targets, no audits, absent AR and settlement are unknown, real zero sales stays zero", async () => {
  const sales = await get(url("sales"));
  expect(sales.kpis[0].target).toBeNull();
  expect(sales.kpis[0].status).toBe("unknown");
  const store = await get(url("store", `storeId=${f.store}`)),
    osa = store.kpis.find((/** @type {any} */ k) => k.key === "osa");
  expect(osa.value).toBeNull();
  expect(osa.status).toBe("unknown");
  const money = await get(url("money"));
  expect(
    money.kpis.find((/** @type {any} */ k) => k.key === "arTotal").value,
  ).toBeNull();
  const none = await get(
    "/api/v1/analytics/sales?from=2020-01-01&to=2020-01-01",
  );
  expect(none.kpis[0].value).toBe(0);
});
test("Saturday pro-rating, centavo apportionment, status thresholds and leap-year compare", async () => {
  expect(sellingDays("2026-10-05", "2026-10-11")).toBe(6);
  expect(prorate(270001, "2026-10", "2026-10-01", "2026-10-31")).toBe(270001);
  const daily = Array.from({ length: 31 }, (_, i) =>
    prorate(
      270001,
      "2026-10",
      `2026-10-${String(i + 1).padStart(2, "0")}`,
      `2026-10-${String(i + 1).padStart(2, "0")}`,
    ),
  );
  expect(daily.reduce((a, b) => a + b, 0)).toBe(270001);
  expect(daily[3]).toBe(0);
  expect(status(899, 1000)).toBe("behind");
  expect(status(900, 1000)).toBe("watch");
  expect(status(999, 1000)).toBe("watch");
  expect(status(1000, 1000)).toBe("ok");
  expect(status(0, null)).toBe("unknown");
  const r = await get(
    "/api/v1/analytics/sales?from=2024-02-29&to=2024-02-29&compare=ly",
  );
  expect(r.compare).toEqual({ from: "2023-02-28", to: "2023-02-28" });
});
test("targets set/import/list audit history, no partial import and effective revisions", async () => {
  const month = f.today.slice(0, 7),
    row = { month, level: "agent", key: f.agent, amountCentavos: 270001 };
  const set = await f.post("/api/v1/targets/set", row);
  expect(set.status).toBe(200);
  expect((await set.json()).applied).toBe(1);
  const list = await get(`/api/v1/targets?month=${month}&level=agent`);
  expect(
    list.rows.find((/** @type {any} */ r) => r.key === f.agent).amountCentavos,
  ).toBe(270001);
  const company = await get(`/api/v1/targets?month=${month}&level=company`);
  expect(company.total).toBe(270001);
  const bad = await f.post("/api/v1/targets/import", {
    month,
    rows: [
      { level: "agent", key: f.agent, amountCentavos: 9 },
      { level: "agent", key: "outside", amountCentavos: 9 },
    ],
  });
  const b = await bad.json();
  expect(b.applied).toBe(0);
  expect(b.errors).toHaveLength(1);
  expect(
    (await get(`/api/v1/targets?month=${month}&level=agent`)).rows.find(
      (/** @type {any} */ r) => r.key === f.agent,
    ).amountCentavos,
  ).toBe(270001);
  await f.post("/api/v1/targets/set", { ...row, amountCentavos: 270002 });
  const [{ n }] = await h.db`select count(*) as n from analytics_target_events`;
  expect(Number(n)).toBe(2);
  const history =
    await h.db`select * from sales_targets where profile_id=${f.agent}`;
  expect(history).toHaveLength(2);
  expect(
    history.filter((/** @type {any} */ r) => r.deleted_at === null),
  ).toHaveLength(1);
  const r = await get(
    `/api/v1/analytics/sales?from=${month}-01&to=${f.today}&groupBy=agent`,
  );
  expect(r.rows.find((/** @type {any} */ r) => r.key === f.agent).target).toBe(
    prorate(270002, month, month + "-01", f.today),
  );
});
test("CSV BOM, RFC4180 nested values and formula-prefix protection", async () => {
  const res = await f.get(url("sales", "format=csv"));
  expect(res.headers.get("content-type")).toContain("text/csv");
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([239, 187, 191]);
  const text = await csv([
    { name: ' \t=HYPERLINK("bad")', detail: "line1\nline2", value: 123 },
  ]).text();
  expect(text).toContain("' \t=HYPERLINK");
  expect(text).toContain('"line1\nline2"');
  expect(text).toContain("\r\n");
});
test("correct cases + pieces and deterministic ICO cap/promotion/observation behavior", async () => {
  const r = await get(url("stock"));
  expect(r.rows[0].onHand).toEqual({
    cases: 4,
    pieces: 2,
    display: "4 cases + 2 pieces",
  });
  const line = suggestLine(
    {
      historyQuantity: 84,
      unit: "pieces",
      lastPurchaseDate: "2026-10-01",
      lastPurchaseQuantity: 5,
      observation: { date: "2026-10-10", quantity: 0 },
      upliftPct: 100,
      available: 3,
    },
    {
      historyDays: 84,
      asOfDate: "2026-10-10",
      nextVisitDays: 7,
      leadTimeDays: 1,
    },
  );
  expect(line.quantity).toBe(3);
  expect(line.reason).toContain("capped");
});
test("scope: supervisor cannot see another team or widen unit filter; source-location withdrawal", async () => {
  await h.db`update profiles set role='manager',org_unit_id=${f.a} where id=${f.boss}`;
  try {
    const r = await get(url("sales", "groupBy=agent"));
    expect(r.kpis[0].value).toBe(450 * 10636);
    expect(r.rows).toHaveLength(6);
    const stores = await get(url("stores", "limit=200"));
    expect(stores.kpis[0].value).toBe(150);
    expect(stores.rows).toHaveLength(150);
    const denied = await f.get(url("sales", `unitId=${f.b}`));
    expect(denied.status).toBe(403);
    const [foreign] =
      await h.db`select id from profiles where auth_subject='agent-2'`;
    expect(
      (await f.get(url("agent-day", `profileId=${foreign.id}&date=${f.today}`)))
        .status,
    ).toBe(403);
    const [loc] =
      await h.db`select id from inventory_locations where org_unit_id=${f.b}`;
    const [order] =
      await h.db`select id,source_location_id from orders where salesperson_subject='agent-0' limit 1`;
    await h.db`update orders set source_location_id=${loc.id} where id=${order.id}`;
    expect((await get(url("sales"))).kpis[0].value).toBe(449 * 10636);
    await h.db`update orders set source_location_id=${order.source_location_id} where id=${order.id}`;
    expect(
      (
        await f.post("/api/v1/targets/set", {
          month: f.today.slice(0, 7),
          level: "company",
          key: "company",
          amountCentavos: 1,
        })
      ).status,
    ).toBe(200);
    const [last] =
      await h.db`select count(*) as n from sales_targets where level='company'`;
    expect(Number(last.n)).toBe(0);
    // WEB-035: the read tells the editor which levels this regional scope may write.
    const m = f.today.slice(0, 7);
    expect(
      (await get(`/api/v1/targets?month=${m}&level=company`)).editable,
    ).toBe(false);
    expect(
      (await get(`/api/v1/targets?month=${m}&level=channel`)).editable,
    ).toBe(false);
    expect((await get(`/api/v1/targets?month=${m}&level=agent`)).editable).toBe(
      true,
    );
  } finally {
    await h.db`update profiles set role='super_admin',org_unit_id=${f.root} where id=${f.boss}`;
  }
  expect(
    (await get(`/api/v1/targets?month=${f.today.slice(0, 7)}&level=company`))
      .editable,
  ).toBe(true);
});
test("rollup retry exactness, planned-only days, cancellation and coalescing/nightly jobs", async () => {
  await rebuildDay(h.db, f.today);
  await rebuildDay(h.db, f.today);
  const [sum] =
    await h.db`select sum(sales_centavos) as n from analytics_daily_sales where service_date=${f.today}`;
  expect(Number(sum.n)).toBe(300 * 10636);
  const [metric] =
    await h.db`select * from agent_daily_metrics where profile_id=${f.agent} and service_date=${f.today}`;
  expect(metric.planned_calls).toBe(1);
  expect(Number(metric.sales_value) * 100).toBe(25 * 10636);
  await h.db`update planned_visits set status='cancelled' where id=${f.planned}`;
  await rebuildDay(h.db, f.today);
  const [after] =
    await h.db`select planned_calls from agent_daily_metrics where profile_id=${f.agent} and service_date=${f.today}`;
  expect(after.planned_calls).toBe(0);
  await h.db`update planned_visits set status='planned' where id=${f.planned}`;
  const ctx = { db: h.db };
  await enqueueRefresh(ctx, { kind: "order", date: f.today, unitId: f.a });
  await enqueueRefresh(ctx, { kind: "visit", date: f.today, unitId: f.a });
  const [jobs] =
    await h.db`select count(*) as n from jobs where kind='analytics.refresh' and coalesce_key=${f.today} and status='pending'`;
  expect(Number(jobs.n)).toBe(1);
  await fullRebuild(h.db);
  const [all] =
    await h.db`select count(*) as n from jobs where kind='analytics.refresh' and status='pending' and coalesce_key>=${f.start}`;
  expect(Number(all.n)).toBe(3);
}, 60000);
test("cached projections reconcile and fail closed after source edits and outlet transfer", async () => {
  await rebuildDay(h.db, f.today);
  const agent = await get(
      `/api/v1/analytics/sales?from=${f.today}&to=${f.today}&groupBy=agent`,
    ),
    channel = await get(
      `/api/v1/analytics/sales?from=${f.today}&to=${f.today}&groupBy=channel`,
    ),
    today = await get(url("today", `date=${f.today}`));
  expect(agent.kpis[0].value).toBe(
    channel.rows.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + r.sales,
      0,
    ),
  );
  expect(today.kpis[0].value).toBe(agent.kpis[0].value);
  const [line] =
    await h.db`select l.id,l.line_total from order_lines l join orders o on o.id=l.order_id where (o.created_at at time zone 'Asia/Manila')::date=${f.today} limit 1`;
  await h.db`update order_lines set line_total=line_total+0.01 where id=${line.id}`;
  expect(
    (await get(`/api/v1/analytics/sales?from=${f.today}&to=${f.today}`)).kpis[0]
      .value,
  ).toBe(agent.kpis[0].value + 1);
  await h.db`update order_lines set line_total=${line.line_total} where id=${line.id}`;
  await rebuildDay(h.db, f.today);
  await h.db`update profiles set role='manager',org_unit_id=${f.a} where id=${f.boss}`;
  const [territory] = await h.db`select id from territories where code='T2'`;
  const [assignment] =
    await h.db`select id,territory_id from outlet_assignments where outlet_id=${f.store}`;
  try {
    await h.db`update outlet_assignments set territory_id=${territory.id} where id=${assignment.id}`;
    expect((await f.get(url("store", `storeId=${f.store}`))).status).toBe(403);
    const r = await get(
      `/api/v1/analytics/sales?from=${f.today}&to=${f.today}`,
    );
    expect(r.kpis[0].value).toBe(149 * 10636);
  } finally {
    await h.db`update outlet_assignments set territory_id=${assignment.territory_id} where id=${assignment.id}`;
    await h.db`update profiles set role='super_admin',org_unit_id=${f.root} where id=${f.boss}`;
  }
});
test("a note-only completed visit is not productive; planned-only days survive refresh", async () => {
  await h.db`update visit_activities set activity_kind='note' where visit_id=${f.visit}`;
  expect(
    (await get(url("agent-day", `profileId=${f.agent}&date=${f.today}`)))
      .summary.productive,
  ).toBe(0);
  await h.db`update visit_executions set deleted_at=now() where id=${f.visit}`;
  await rebuildDay(h.db, f.today);
  const [row] =
    await h.db`select planned_calls,calls,productive_calls from agent_daily_metrics where profile_id=${f.agent} and service_date=${f.today}`;
  expect(row.planned_calls).toBe(1);
  expect(row.calls).toBe(0);
  expect(row.productive_calls).toBe(0);
  await h.db`update visit_executions set deleted_at=null where id=${f.visit}`;
  await h.db`update visit_activities set activity_kind='merchandising' where visit_id=${f.visit}`;
});
test("legacy monthly targets remain readable and v2 overrides preserve future history", async () => {
  const [person] =
    await h.db`select id from profiles where auth_subject='agent-1'`;
  const [legacy] =
    await h.db`insert into sales_targets(organization_id,subject_kind,profile_id,period,metric,value,effective_from,source_ref,created_by) values('fixture','employee',${person.id},'monthly','sales_value',1234.56,'2020-01-01','legacy-fixture','fixture') returning id`;
  const month = f.today.slice(0, 7);
  expect(
    (await get(`/api/v1/targets?month=${month}&level=agent`)).rows.find(
      (/** @type {any} */ r) => r.key === person.id,
    ).amountCentavos,
  ).toBe(123456);
  const res = await f.post("/api/v1/targets/set", {
    month,
    level: "agent",
    key: person.id,
    amountCentavos: 99999,
  });
  expect((await res.json()).applied).toBe(1);
  expect(
    (await get(`/api/v1/targets?month=${month}&level=agent`)).rows.find(
      (/** @type {any} */ r) => r.key === person.id,
    ).amountCentavos,
  ).toBe(99999);
  expect(
    (await get("/api/v1/targets?month=2030-01&level=agent")).rows.find(
      (/** @type {any} */ r) => r.key === person.id,
    ).amountCentavos,
  ).toBe(123456);
  const [kept] =
    await h.db`select deleted_at from sales_targets where id=${legacy.id}`;
  expect(kept.deleted_at).toBeNull();
});
test("CSV works on every row endpoint and targets; analyst cannot manage targets", async () => {
  for (const page of [
    "sales",
    "coverage",
    "stores",
    "stock",
    "vans",
    "money",
  ]) {
    const res = await f.get(url(page, "format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)]).toEqual([
      239, 187, 191,
    ]);
  }
  expect(
    (
      await f.get(
        `/api/v1/targets?month=${f.today.slice(0, 7)}&level=agent&format=csv`,
      )
    ).headers.get("content-type"),
  ).toContain("text/csv");
  await h.db`update profiles set role='analyst' where id=${f.boss}`;
  try {
    expect(
      (
        await f.post("/api/v1/targets/set", {
          month: f.today.slice(0, 7),
          level: "company",
          key: "company",
          amountCentavos: 10,
        })
      ).status,
    ).toBe(403);
  } finally {
    await h.db`update profiles set role='super_admin' where id=${f.boss}`;
  }
});
test("analytics notifications coalesce within the five-second window", async () => {
  const handlers = new Map();
  let published = 0;
  installRefresh({
    registerJob: (/** @type {string} */ kind, /** @type {any} */ fn) =>
      handlers.set(kind, fn),
    scheduler: { daily: () => {} },
    publish: async (/** @type {string} */ topic) => {
      expect(topic).toBe("analytics");
      published++;
    },
  });
  await handlers.get("analytics.notify")({ db: h.db });
  await handlers.get("analytics.notify")({ db: h.db });
  expect(published).toBe(1);
  const [queued] =
    await h.db`select count(*) as n from jobs where kind='analytics.notify' and status='pending'`;
  expect(Number(queued.n)).toBe(1);
});
test("time in market sums daily spans rather than overnight gaps", () => {
  const visits = [
    {
      assignee_profile_id: "p",
      service_date: "2026-10-01",
      started_at: "2026-10-01T09:00:00+08:00",
      ended_at: "2026-10-01T09:30:00+08:00",
    },
    {
      assignee_profile_id: "p",
      service_date: "2026-10-02",
      started_at: "2026-10-02T09:00:00+08:00",
      ended_at: "2026-10-02T10:00:00+08:00",
    },
  ];
  expect(visitSummary({ planned: [], visits, coaching: [] }).time).toBe(90);
});
test("validation: malformed dates/groups/months fail without SQL errors", async () => {
  for (const path of [
    "/api/v1/analytics/sales?from=2026-02-30",
    "/api/v1/analytics/sales?groupBy=surprise",
    "/api/v1/targets?month=2026-13",
  ])
    expect((await f.get(path)).status).toBe(400);
  expect((await h.fetch("/api/v1/analytics/sales")).status).toBe(401);
});
test("F-208 productive qualification is separate from linked-order strike rate and never counts an inaccessible source order", async () => {
  const db = h.db,
    [owner] =
      await db`select role,org_unit_id from profiles where id=${f.boss}`;
  const [order] =
    await db`select * from orders where customer_code='C0' order by created_at desc,id limit 1`;
  const [profile] =
    await db`select auth_subject from profiles where id=${f.agent}`;
  const [act] =
    await db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values ('fixture',${f.a},${f.visit},${f.agent},${f.store},'order_intent',${{ clientOrderId: crypto.randomUUID(), lines: [] }},now(),now()) returning id`;
  const row = async () => {
    const r = await get(url("coverage"));
    return r.rows.find((/** @type {any} */ r) => r.key === f.agent);
  };
  try {
    expect((await row()).productiveRatePct).toBe(100);
    expect((await row()).strikeRatePct).toBe(0);
    await db`update orders set source_activity_id=${act.id},salesperson_profile_id=${f.agent},created_by_subject=${profile.auth_subject},outlet_id=${f.store},org_unit_id=${f.a},source_location_id=null,status='approved' where id=${order.id}`;
    expect((await row()).strikeRatePct).toBe(100);
    expect((await row()).orderCalls).toBe(1);
    await db`update profiles set role='manager',org_unit_id=${f.a} where id=${f.boss}`;
    const [foreign] =
      await db`select id from inventory_locations where org_unit_id=${f.b} limit 1`;
    await db`update orders set source_location_id=${foreign.id} where id=${order.id}`;
    expect((await row()).strikeRatePct).toBe(0);
    await db`update orders set source_location_id=null,customer_code='C2' where id=${order.id}`;
    expect((await row()).strikeRatePct).toBe(0);
  } finally {
    await db`update orders set source_activity_id=${order.source_activity_id},salesperson_profile_id=${order.salesperson_profile_id},created_by_subject=${order.created_by_subject},outlet_id=${order.outlet_id},org_unit_id=${order.org_unit_id},source_location_id=${order.source_location_id},status=${order.status},customer_code=${order.customer_code} where id=${order.id}`;
    await db`delete from order_intent_queue where activity_id=${act.id}`;
    await db`delete from visit_activities where id=${act.id}`;
    await db`update profiles set role=${owner.role},org_unit_id=${owner.org_unit_id} where id=${f.boss}`;
  }
});
