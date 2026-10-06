import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const report = {
  serviceDate: "2026-09-28",
  localMonth: "2026-09",
  salesman: { name: "Ana Cruz", employeeCode: null, position: "Route Sales" },
  areaCovered: ["Route 1 Poblacion"],
  invoiceNumbers: ["SI-001", "SI-003"],
  sellingDay: true,
  sellingDaysInMonth: 26,
  targets: {
    daily: 384_615,
    dailySource: "derived_from_monthly",
    monthly: 10_000_000,
    sourceRef: "Sept 2026 allocation",
  },
  totals: {
    todaySales: 160_050,
    todayPct: 41,
    mtdSales: 340_050,
    mtdPct: 3,
    balanceToSell: 9_659_950,
  },
  calls: {
    planned: 3,
    calls: 2,
    productiveCalls: 1,
    productivePct: 50,
    dailyCallsTarget: 30,
    productiveCallTargetPct: 85,
  },
  customers: [
    {
      key: "outlet:o1",
      outletCode: "O1",
      customerCode: "C1",
      name: "Outlet 1",
      inRoutePlan: true,
      callStatus: "productive",
      matchedCodes: ["purchase_order"],
      todaySales: 140_050,
      mtdSales: 290_050,
      invoiceNumbers: ["SI-001"],
      reasonCode: null,
      remarks: ["Competitor display at entrance"],
    },
    {
      key: "outlet:o3",
      outletCode: "O3",
      customerCode: null,
      name: "Outlet 3",
      inRoutePlan: true,
      callStatus: "not_visited",
      matchedCodes: [],
      todaySales: 0,
      mtdSales: 0,
      invoiceNumbers: [],
      reasonCode: null,
      remarks: [],
    },
    {
      key: "customer:C9",
      outletCode: null,
      customerCode: "C9",
      name: "Walk-in Nine",
      inRoutePlan: false,
      callStatus: null,
      matchedCodes: [],
      todaySales: 20_000,
      mtdSales: 20_000,
      invoiceNumbers: ["SI-003"],
      reasonCode: null,
      remarks: [],
    },
  ],
  categories: [
    {
      category: "Canned",
      todaySales: 90_050,
      todayQuantity: 1,
      mtdSales: 120_050,
      mtdQuantity: 4,
    },
    {
      category: "Mixes",
      todaySales: 0,
      todayQuantity: 0,
      mtdSales: 0,
      mtdQuantity: 0,
    },
    {
      category: "Frozen",
      todaySales: 50_000,
      todayQuantity: 1,
      mtdSales: 150_000,
      mtdQuantity: 3,
    },
  ],
  programs: [
    { programRef: "PROMO-SEPT", executed: 1, notExecuted: 0, notApplicable: 0 },
  ],
};

const queries = vi.hoisted(() => ({
  salesmen: undefined as unknown,
  day: undefined as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref as never);
    if (name === "dsr/report:salesmen") return queries.salesmen;
    if (name === "dsr/report:day") return queries.day;
    return undefined;
  },
}));

import { DailySalesView, DailySalesWorkspace } from "./daily-sales-workspace";

describe("daily sales report screens", () => {
  it("renders the Annex B sheet: header, targets, coverage, blocks and signatures", () => {
    // The New products placeholder is on the beta hidden list; switch it on here.
    vi.stubEnv("NEXT_PUBLIC_BETA_ENABLE", "dsr-new-products");
    const html = renderToStaticMarkup(
      <DailySalesView report={report as never} />,
    );
    vi.unstubAllEnvs();
    expect(html).toContain("Daily Sales Report · Ana Cruz");
    expect(html).toContain("SI-001, SI-003");
    expect(html).toContain("Route 1 Poblacion");
    expect(html).toContain("₱1,600.50");
    expect(html).toContain(
      "Target ₱3,846.15 · 41% · Monthly target ÷ 26 selling days",
    );
    expect(html).toContain("₱3,400.50");
    expect(html).toContain("₱96,599.50");
    expect(html).toContain("1 of 2");
    expect(html).toContain(
      "50% · 3 planned · standard 30 calls, 85% productive",
    );
    expect(html).toContain("Productive");
    expect(html).toContain("Not visited");
    expect(html).toContain("not in route plan");
    expect(html).toContain("PO · Competitor display at entrance");
    expect(html).toContain(">Canned<");
    expect(html).toContain(">Mixes<");
    expect(html).toContain(">Frozen<");
    expect(html).toContain("New products");
    expect(html).toContain("PROMO-SEPT");
    expect(html).toContain("Salesman signature / date");
    expect(html).toContain("CDM / COM signature / date");
  });

  it("hides the empty New products placeholder for the beta", () => {
    vi.stubEnv("NEXT_PUBLIC_BETA_ENABLE", "");
    const html = renderToStaticMarkup(
      <DailySalesView report={report as never} />,
    );
    vi.unstubAllEnvs();
    expect(html).not.toContain("New products");
    expect(html).not.toContain("Waiting for Sunpride");
    expect(html).toContain("PROMO-SEPT");
    expect(html).toContain("lg:grid-cols-2");
  });

  it("says so when the day has no coverage", () => {
    const html = renderToStaticMarkup(
      <DailySalesView
        report={{ ...report, customers: [], programs: [] } as never}
      />,
    );
    expect(html).toContain(
      "No route-plan stores, visits or sales on this day.",
    );
    expect(html).toContain("No programs checked today.");
  });

  it("opens a salesman's own sheet without a picker", () => {
    queries.salesmen = {
      self: true,
      truncated: false,
      people: [
        {
          profileId: "p1",
          name: "Ana Cruz",
          employeeCode: null,
          position: "Route Sales",
        },
      ],
    };
    queries.day = report;
    const html = renderToStaticMarkup(<DailySalesWorkspace />);
    expect(html).not.toContain("Choose a salesman");
    expect(html).toContain("Daily Sales Report · Ana Cruz");
    expect(html).toContain("Export CSV");
  });

  it("asks a supervisor to choose a salesman", () => {
    queries.salesmen = {
      self: false,
      truncated: false,
      people: [
        {
          profileId: "p1",
          name: "Ana Cruz",
          employeeCode: null,
          position: null,
        },
        {
          profileId: "p2",
          name: "Ben Reyes",
          employeeCode: null,
          position: null,
        },
      ],
    };
    const html = renderToStaticMarkup(<DailySalesWorkspace />);
    expect(html).toContain("Choose a salesman…");
    expect(html).toContain("Ben Reyes");
    expect(html).toContain(
      "Choose a salesman to see their daily sales report.",
    );
    expect(html).not.toContain("Daily Sales Report · ");
  });

  it("explains an empty list to readers without a team", () => {
    queries.salesmen = { self: false, truncated: false, people: [] };
    const html = renderToStaticMarkup(<DailySalesWorkspace />);
    expect(html).toContain("No salesmen in your area.");
  });
});
