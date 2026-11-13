import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  csvHref,
  fixtureModeAllowed,
  valuationCsvHref,
  valuationQuery,
  VALUATION_PATH,
} from "./api";
import { breadcrumbs, decodeCrumbs, drillHref } from "./drill";
import { analyticsFixture, fixtureNow, valuationFromStock } from "./fixtures";
import {
  formatCasesPieces,
  formatKpiValue,
  formatPct,
  formatPhp,
} from "./format";
import { EmptyState } from "./kit/empty-state";
import { closeOnEscape, Drawer } from "./kit/drawer";
import { DemoBadge, freshnessText } from "./kit/freshness";
import { KpiCard } from "./kit/kpi-card";
import { PanelBoundary } from "./kit/panel";
import { AgentDayView, CoverageView } from "./pages/coverage";
import { DecideView } from "./pages/decide";
import { MoneyView } from "./pages/money";
import { SalesView } from "./pages/sales";
import { StockView, stockColumns, stockFromValuation } from "./pages/stock";
import { StoresView, StoreView } from "./pages/stores";
import { TodayView } from "./pages/today";
import { canAccessWebModule } from "@/lib/module-access";
import { VansView } from "./pages/vans";
import type { Kpi } from "./types";

const NOW = fixtureNow(Date.parse("2026-10-19T12:00:00+08:00"));
const MTD = { from: "2026-10-01", to: "2026-10-19" };
const html = (node: React.ReactElement) =>
  renderToStaticMarkup(node).replaceAll("&amp;", "&").replaceAll("&#x27;", "'");
const kpiValues = (kpis: Kpi[]) =>
  kpis.filter((k) => k.value !== null).map(formatKpiValue);

afterEach(() => vi.unstubAllEnvs());

describe("pages render their contract fixture", () => {
  it("r6: Today offers 'Open all in Decide' only to roles that can open Decide", () => {
    const data = analyticsFixture("today", { date: MTD.to }, NOW);
    expect(html(<TodayView data={data} />)).toContain("Open all in Decide");
    expect(html(<TodayView data={data} canOpenDecide={false} />)).not.toContain(
      "Open all in Decide",
    );
    expect(canAccessWebModule("decide", "sales")).toBe(false);
    expect(canAccessWebModule("decide", "manager")).toBe(true);
  });
  it("an empty selected-day channel panel never claims the month has no sales", () => {
    const data = analyticsFixture("today", { date: MTD.to }, NOW);
    data.byChannel = [];
    const out = html(<TodayView data={data} />);
    expect(out).toContain("No sales recorded on this day yet");
    expect(out).not.toContain("this month yet");
  });
  it("customer returns keep their exact pieces, separate from stock sent back to the depot", () => {
    const data = analyticsFixture("vans", { date: MTD.to }, NOW);
    data.rows = data.rows.slice(0, 1).map((r) => ({
      ...r,
      returnedCases: 10,
      customerReturnedCases: 1 / 24,
      customerReturns: [
        {
          name: "Sample Sardines",
          quantity: { cases: 0, pieces: 1, display: "0 cases + 1 pieces" },
        },
      ],
    }));
    const out = html(<VansView data={data} csv="/csv" />);
    expect(out).toContain(
      "Customer returns: Sample Sardines · 0 cases + 1 pieces",
    );
    expect(out).toContain("10 cs");
    expect(out).not.toContain("Customer returns: 0 cs");
  });
  it("zero cash and stock differences are Balanced, not zero over or extra", () => {
    const data = analyticsFixture("vans", { date: MTD.to }, NOW);
    data.rows = data.rows
      .slice(0, 1)
      .map((r) => ({ ...r, variance: 0, stockVarianceCases: 0 }));
    const out = html(<VansView data={data} csv="/csv" />);
    expect(out).toContain("Balanced");
    expect(out).not.toContain("₱0.00 over");
    expect(out).not.toContain("0 cs extra");
  });
  it("shows missing coaching minimums without an unfinished 'of' label", () => {
    const data = analyticsFixture("coverage", MTD, NOW);
    data.rows[0]!.workWith = { done: 0, required: null };
    expect(
      html(<CoverageView data={data} groupBy="agent" csv="/csv" />),
    ).toContain("0 recorded · no minimum");
  });
  it("exposes the decision continuation cursor rather than hiding remaining work", () => {
    const data = analyticsFixture("exceptions", MTD, NOW);
    data.next = "another-page";
    expect(
      html(
        <DecideView
          data={data}
          kind={null}
          severity={null}
          onMore={() => {}}
        />,
      ),
    ).toContain("Next items");
  });
  it("uses exact case-and-piece suggested quantities instead of raw float cases", () => {
    const data = analyticsFixture(
      "store",
      { ...MTD, storeId: "store-001" },
      NOW,
    );
    data.suggestedOrder = [
      {
        productId: "p1",
        qtyCases: 1 / 24,
        quantityDisplay: "0 cases + 1 pieces",
        reason: "Demand",
      },
    ];
    const out = html(<StoreView data={data} />);
    expect(out).toContain("0 cases + 1 pieces");
    expect(out).not.toContain("0.041666666");
  });
  it("Today: KPI row, channels, field board, vans and the top exceptions", () => {
    const data = analyticsFixture("today", { date: "2026-10-19" }, NOW);
    const out = html(<TodayView data={data} now={NOW} />);
    for (const value of kpiValues(data.kpis)) expect(out).toContain(value);
    expect(out).toMatch(/₱[\d,]+/);
    for (const channel of data.byChannel) expect(out).toContain(channel.label);
    for (const van of data.vans) expect(out).toContain(van.truck);
    expect(data.exceptions.length).toBeLessThanOrEqual(5);
    for (const item of data.exceptions) expect(out).toContain(item.title);
    expect(freshnessText(data.freshness)).toBe(
      "Updated 3:05 PM · 3 phones not synced since 2:10 PM",
    );
    expect(html(<DemoBadge demo />)).toMatch(/demo data/i);
    expect(html(<DemoBadge demo={false} />)).toBe("");
  });

  it("Sales: peso rows, attainment % and the booked/approved/posted strip", () => {
    const params = new URLSearchParams(MTD);
    const data = analyticsFixture(
      "sales",
      { ...MTD, groupBy: "territory" },
      NOW,
    );
    const out = html(
      <SalesView
        data={data}
        groupBy="territory"
        pathname="/sales"
        params={params}
        csv={csvHref("sales", { ...MTD, groupBy: "territory" })}
      />,
    );
    for (const row of data.rows) {
      expect(out).toContain(row.label);
      expect(out).toContain(formatPhp(row.sales));
      if (row.attainmentPct !== null)
        expect(out).toContain(formatPct(row.attainmentPct));
    }
    expect(out).toContain(formatPhp(data.stages.booked));
    expect(out).toContain(formatPhp(data.stages.posted));
  });

  it("Sales: territory rows add up to the month-to-date KPI", () => {
    const data = analyticsFixture(
      "sales",
      { ...MTD, groupBy: "territory" },
      NOW,
    );
    const total = data.kpis.find((k) => k.key === "sales")!.value;
    expect(data.rows.reduce((s, r) => s + r.sales, 0)).toBe(total);
  });

  it("Products & stock: cases and pieces with days of cover", () => {
    const data = analyticsFixture("stock", MTD, NOW);
    const out = html(
      <StockView data={data} csv="/api/v1/analytics/stock?format=csv" />,
    );
    const row = data.rows.find((r) => r.onHand.pieces > 0) ?? data.rows[0]!;
    expect(out).toContain(row.name);
    expect(out).toContain(
      formatCasesPieces(row.onHand.cases, row.onHand.pieces),
    );
    expect(out).toMatch(/\d+ cs/);
  });

  it("WEB-060 Products & stock links to Inventory", () => {
    const data = analyticsFixture("stock", MTD, NOW);
    const out = html(<StockView data={data} csv="/x" />);
    expect(out).toMatch(/href="\/inventory"[^>]*>Open Inventory</);
  });

  it("Coverage, agent day, stores, store, vans, money and decide render plain labels", () => {
    const coverage = analyticsFixture("coverage", MTD, NOW);
    const coverageOut = html(
      <CoverageView data={coverage} groupBy="agent" csv="/c.csv" />,
    );
    expect(coverageOut).toContain(coverage.rows[0]!.label);

    const agentId = coverage.rows[0]!.key;
    const day = analyticsFixture(
      "agent-day",
      { profileId: agentId, date: "2026-10-19" },
      NOW,
    );
    expect(html(<AgentDayView data={day} />)).toContain(day.person.name);

    const stores = analyticsFixture("stores", MTD, NOW);
    const storesOut = html(
      <StoresView data={stores} csv="/s.csv" now={NOW} />,
    );
    expect(storesOut).toContain(stores.rows[0]!.name);
    expect(storesOut).toContain(formatPhp(stores.rows[0]!.salesPeriod));

    const store = analyticsFixture(
      "store",
      { ...MTD, storeId: stores.rows[0]!.storeId },
      NOW,
    );
    expect(html(<StoreView data={store} now={NOW} />)).toContain(
      store.store.name,
    );

    const vans = analyticsFixture("vans", { date: "2026-10-19" }, NOW);
    const vansOut = html(<VansView data={vans} csv="/v.csv" />);
    expect(vansOut).toContain(vans.rows[0]!.truck);
    expect(vansOut).toMatch(/₱[\d,.]+ short|not yet/);

    const money = analyticsFixture("money", MTD, NOW);
    const moneyOut = html(<MoneyView data={money} csv="/m.csv" now={NOW} />);
    expect(moneyOut).toContain(money.rows[0]!.name);
    expect(moneyOut).toContain(formatPhp(money.aging.current));

    const decide = analyticsFixture("exceptions", MTD, NOW);
    const decideOut = html(
      <DecideView data={decide} kind={null} severity={null} now={NOW} />,
    );
    expect(decideOut).toContain(decide.items[0]!.title);

    // No raw ids or generic errors anywhere.
    for (const out of [coverageOut, storesOut, vansOut, moneyOut, decideOut]) {
      expect(out).not.toContain("Something went wrong");
      expect(out).not.toMatch(/>p\d+</);
    }
  });
});

describe("empty states keep unknown, zero and setup apart", () => {
  it("renders three distinct variants", () => {
    const unknown = html(
      <EmptyState variant="unknown" title="No phones synced" />,
    );
    const zero = html(<EmptyState variant="zero" title="No orders" />);
    const setup = html(
      <EmptyState
        variant="setup"
        title="No target"
        action={{ label: "Set target", href: "/sales?tab=targets" }}
      />,
    );
    expect(unknown).toContain('data-empty="unknown"');
    expect(unknown).toContain("Not measured yet");
    expect(zero).toContain('data-empty="zero"');
    expect(zero).toContain("None in this period");
    expect(setup).toContain("Needs setup");
    expect(setup).toContain('href="/sales?tab=targets"');
  });

  const base: Kpi = {
    key: "sales",
    label: "Month to date",
    value: 0,
    unit: "php",
    target: null,
    prior: null,
    deltaPct: null,
    status: "unknown",
    definition: "Posted sales net of returns.",
  };

  it("a KPI distinguishes a real zero, an unknown value and a missing target", () => {
    const zero = html(<KpiCard kpi={base} />);
    expect(zero).toContain("₱0");
    expect(zero).toContain("Set target");
    expect(zero).toContain('href="/sales?tab=targets"');

    const unknown = html(<KpiCard kpi={{ ...base, value: null }} />);
    expect(unknown).toContain("Not measured yet");
    expect(unknown).not.toContain("₱0");

    const readOnly = html(<KpiCard kpi={base} canSetTarget={false} />);
    expect(readOnly).not.toContain("Set target");
  });

  it("a KPI shows the target bar, the delta arrow, the status and its definition", () => {
    const out = html(
      <KpiCard
        kpi={{
          ...base,
          value: 750_000_00,
          target: 1_000_000_00,
          deltaPct: 4.2,
          status: "watch",
        }}
      />,
    );
    expect(out).toContain("₱750,000");
    expect(out).toContain("75.0% of ₱1,000,000");
    expect(out).toContain("▲");
    expect(out).toContain("4.2%");
    expect(out).toContain('data-status="watch"');
    expect(out).toContain("Posted sales net of returns.");
  });
});

describe("drill-down", () => {
  it("pushes groupBy, parent and a crumb into the URL", () => {
    const search = new URLSearchParams({ ...MTD, groupBy: "territory" });
    const href = drillHref("/sales", search, {
      label: "Talisay – Minglanilla",
      drill: { groupBy: "agent", parent: "territory:t-tmg" },
    });
    const next = new URL(href, "http://x").searchParams;
    expect(next.get("groupBy")).toBe("agent");
    expect(next.get("parent")).toBe("territory:t-tmg");
    expect(next.get("from")).toBe(MTD.from);
    expect(decodeCrumbs(next)).toEqual([
      {
        groupBy: "agent",
        parent: "territory:t-tmg",
        label: "Talisay – Minglanilla",
      },
    ]);

    const deeper = new URL(
      drillHref("/sales", next, {
        label: "Liza Cabahug",
        drill: { groupBy: "store", parent: "agent:p10" },
      }),
      "http://x",
    ).searchParams;
    const trail = breadcrumbs("/sales", deeper, {
      label: "All territories",
      groupBy: "territory",
    });
    expect(trail.map((c) => c.label)).toEqual([
      "All territories",
      "Talisay – Minglanilla",
      "Liza Cabahug",
    ]);
    expect(trail.map((c) => c.current)).toEqual([false, false, true]);
    const back = new URL(trail[1]!.href, "http://x").searchParams;
    expect(back.get("groupBy")).toBe("agent");
    expect(back.getAll("crumb")).toHaveLength(1);
    expect(
      new URL(trail[0]!.href, "http://x").searchParams.get("parent"),
    ).toBeNull();
  });

  it("table rows link to the drill and the page shows breadcrumbs", () => {
    const search = new URLSearchParams({
      ...MTD,
      groupBy: "agent",
      parent: "territory:t-tmg",
      crumb: "agent~territory:t-tmg~Talisay – Minglanilla",
    });
    const data = analyticsFixture(
      "sales",
      { ...MTD, groupBy: "agent", parent: "territory:t-tmg" },
      NOW,
    );
    const out = html(
      <SalesView
        data={data}
        groupBy="agent"
        pathname="/sales"
        params={search}
        csv="/x.csv"
      />,
    );
    expect(out).toContain('aria-label="Drill path"');
    expect(out).toContain("Talisay – Minglanilla");
    expect(out).toMatch(/href="\/sales\?[^"]*groupBy=store/);
    expect(out).toMatch(/href="\/sales\?[^"]*parent=agent%3A/);
  });
});

describe("F-601 Excel export", () => {
  it("carries the current filters and format=xlsx", () => {
    const href = csvHref("sales", {
      ...MTD,
      unitId: "u-south",
      channel: "kas",
      compare: "ly",
      groupBy: "agent",
      parent: "territory:t-tmg",
      cursor: "",
    });
    const url = new URL(href, "http://x");
    expect(url.pathname).toMatch(/\/analytics\/sales$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...MTD,
      unitId: "u-south",
      channel: "kas",
      compare: "ly",
      groupBy: "agent",
      parent: "territory:t-tmg",
      format: "xlsx",
    });
  });

  it("the drill table offers that link", () => {
    const csv = csvHref("stock", { ...MTD, channel: "gt" });
    const out = html(
      <StockView data={analyticsFixture("stock", MTD, NOW)} csv={csv} />,
    );
    expect(out).toContain(`href="${csv}"`);
    expect(out).toContain("Download Excel");
  });
});

describe("panel error boundary", () => {
  it("turns a failing panel into a named error with retry, and retry remounts it", () => {
    const boundary = new PanelBoundary({
      label: "Sales by channel",
      children: <p>ok</p>,
    });
    boundary.setState = (update) => {
      const patch =
        typeof update === "function"
          ? update(boundary.state, boundary.props)
          : update;
      boundary.state = { ...boundary.state, ...patch };
    };
    boundary.state = {
      ...boundary.state,
      ...PanelBoundary.getDerivedStateFromError(new Error("boom")),
    };
    const failed = html(boundary.render() as React.ReactElement);
    expect(failed).toContain("Couldn't load sales by channel.");
    expect(failed).toContain("Retry");
    expect(failed).not.toContain("Something went wrong");

    boundary.retry();
    expect(boundary.state.error).toBeNull();
    expect(html(boundary.render() as React.ReactElement)).toContain(
      "<p>ok</p>",
    );
  });

  it("sibling panels render when one panel fails", () => {
    const Broken = () => {
      throw new Error("bad figures");
    };
    const failing = new PanelBoundary({ label: "Vans", children: <Broken /> });
    failing.state = {
      ...failing.state,
      ...PanelBoundary.getDerivedStateFromError(new Error("x")),
    };
    const page = html(
      <main>
        <section>Sales fine</section>
        {failing.render()}
      </main>,
    );
    expect(page).toContain("Sales fine");
    expect(page).toContain("Couldn't load vans.");
  });
});

describe("drawers", () => {
  it("Escape closes; other keys and handled events do not", () => {
    const onClose = vi.fn();
    expect(
      closeOnEscape({ key: "Enter", defaultPrevented: false }, onClose),
    ).toBe(false);
    expect(
      closeOnEscape({ key: "Escape", defaultPrevented: true }, onClose),
    ).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      closeOnEscape({ key: "Escape", defaultPrevented: false }, onClose),
    ).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("an open drawer has a close button", () => {
    const out = html(
      <Drawer open title="Over credit limit" onClose={() => {}}>
        <p>detail</p>
      </Drawer>,
    );
    expect(out).toContain('role="dialog"');
    expect(out).toContain(">Close<");
    expect(
      html(
        <Drawer open={false} title="x" onClose={() => {}}>
          x
        </Drawer>,
      ),
    ).toBe("");
  });
});

describe("fixture mode", () => {
  it("is never allowed in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(fixtureModeAllowed()).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(fixtureModeAllowed()).toBe(true);
  });
});

describe("F-602 F-605 one labelled measurement vocabulary", () => {
  it("F-605 keeps order conversion, productive calls, in-store dwell and market span in separate columns", () => {
    const data = analyticsFixture("coverage", MTD, NOW);
    data.rows = data.rows.slice(0, 1).map((r) => ({
      ...r,
      strikeRatePct: 33.3,
      productiveCallPct: 100,
      dwellMin: 60,
      timeInMarketMin: 150,
      dropSize: 12345,
      rank: 1,
      distributionGained: 2,
    }));
    const out = html(
      <CoverageView
        data={data}
        groupBy="agent"
        csv="/api/v1/analytics/coverage?format=xlsx"
      />,
    );
    for (const label of [
      "Strike rate",
      "Productive calls",
      "Time in store",
      "Day in market",
      "Conversion rank",
      "Stocking points gained",
    ])
      expect(out).toContain(label);
    expect(out).toContain(formatPct(33.3));
    expect(out).toContain(formatPct(100));
    expect(out).toContain("Download Excel");
  });
  it("F-602 preserves buying reach separately from stocking and weighted distribution", () => {
    const data = analyticsFixture("stock", MTD, NOW);
    data.rows = data.rows.slice(0, 1).map((r) => ({
      ...r,
      numericDistributionPct: 25,
      weightedDistributionPct: 90,
      buyingReachPct: 80,
      unmeasuredStores: 2,
    }));
    const out = html(
      <StockView data={data} csv="/api/v1/analytics/stock?format=xlsx" />,
    );
    for (const label of [
      "Stocking distribution",
      "Buying reach",
      "Weighted stocking",
      "Not checked",
    ])
      expect(out).toContain(label);
    expect(out).toContain(formatPct(25));
    expect(out).toContain(formatPct(80));
    expect(out).toContain(formatPct(90));
    expect(out).not.toContain("Stores carrying");
  });
});

describe("IP-INT2: Products & stock reads the stock valuation, cost value first", () => {
  it("asks /inventory/valuation for cost, one row per product, and links its pesos CSV", () => {
    expect(VALUATION_PATH).toBe("/api/v1/inventory/valuation");
    expect(valuationQuery({ ...MTD, channel: "gt" })).toEqual({
      basis: "cost",
      groupBy: "product",
    });
    expect(valuationCsvHref(MTD)).toContain("/api/v1/inventory/valuation");
    expect(valuationCsvHref(MTD)).toContain("format=csv");
  });

  it("takes quantity and value from the valuation, not from analytics; cost value comes before selling value", () => {
    const sales = analyticsFixture("stock", MTD, NOW);
    const valuation = valuationFromStock(sales);
    valuation.rows[0] = {
      ...valuation.rows[0]!,
      costValueCentavos: 123_456_00,
      sellingValueCentavos: 150_000_00,
      onHand: {
        base: 99,
        cases: 4,
        pieces: 3,
        display: "4 cs 3 pc",
        valueCentavos: 123_456_00,
      },
    };
    const view = stockFromValuation(valuation, sales);
    const row = view.rows.find(
      (r) => r.productId === valuation.rows[0]!.productId,
    )!;
    expect(row.valueCentavos).toBe(123_456_00);
    expect(row.onHand.display).toBe("4 cs 3 pc");
    expect(row.sellingValueCentavos).toBe(150_000_00);
    // the selling-rate columns still come from analytics for the same product
    expect(row.daysCover).toBe(
      sales.rows.find((r) => r.productId === row.productId)!.daysCover,
    );
    expect(view.kpis.map((k) => k.label).slice(0, 2)).toEqual([
      "Stock value (at cost)",
      "Selling value",
    ]);
    const out = html(
      <StockView data={view} csv="" valuationCsv={valuationCsvHref(MTD)} />,
    );
    const labels = stockColumns.map((c) => c.label);
    expect(labels.indexOf("Cost value")).toBeGreaterThan(-1);
    expect(labels.indexOf("Cost value")).toBeLessThan(
      labels.indexOf("Selling value"),
    );
    expect(out).toContain("Cost value");
    expect(out).toContain("4 cs 3 pc");
    expect(out).toContain("Download CSV (pesos)");
    expect(out).not.toContain("Download Excel");
  });

  it("stock with no cost or price says so instead of showing zero; products in two places are summed", () => {
    const sales = analyticsFixture("stock", MTD, NOW);
    const valuation = valuationFromStock(sales);
    const a = valuation.rows[0]!;
    valuation.rows = [
      {
        ...a,
        locationId: "depot",
        costKnown: false,
        costValueCentavos: 0,
        sellingValueCentavos: null,
      },
      {
        ...valuation.rows[1]!,
        locationId: "truck",
        locationName: "Truck 1",
        onHand: {
          base: 30,
          cases: 1,
          pieces: 6,
          display: "1 cs 6 pc",
          valueCentavos: 1000,
        },
        units: { basePerCase: 24 },
      },
      {
        ...valuation.rows[1]!,
        locationId: "depot",
        locationName: "Main depot",
        onHand: {
          base: 20,
          cases: 0,
          pieces: 20,
          display: "20 pc",
          valueCentavos: 1000,
        },
        units: { basePerCase: 24 },
      },
    ];
    valuation.totals = {
      ...valuation.totals,
      rowsWithoutCost: 1,
      rowsWithoutPrice: 1,
    };
    const view = stockFromValuation(valuation, null);
    const out = html(<StockView data={view} csv="" valuationCsv="/x.csv" />);
    expect(out).toContain("No cost yet");
    expect(out).toContain("No price yet");
    const merged = view.rows.find(
      (r) => r.productId === valuation.rows[1]!.productId,
    )!;
    expect(merged.onHand).toMatchObject({ cases: 2, pieces: 2 });
    expect(view.locations.map((l) => l.label).sort()).toEqual([
      "Main depot",
      "Truck 1",
    ]);
  });
});
