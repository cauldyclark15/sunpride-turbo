import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PositionStandardsPanel,
  sellingWeekLabel,
} from "./position-standards-panel";

const SOURCE = "Sir Francis email 2026-09-30 / call 2026-10-02";

vi.mock("convex/react", () => ({
  useQuery: () => ({
    definition: {
      ruleVersion: "productive-call/2026-10-02",
      activities: [
        { code: "purchase_order", label: "Purchase order" },
        { code: "suggested_order", label: "Suggested order (ICO)" },
        { code: "bad_order_pickup", label: "Bad order (BO) pickup" },
      ],
      noSalesMarker: "no_sales_due_to_inventory",
      rules: [
        { code: "any_listed_activity", label: "Any one listed activity" },
        { code: "truck_seller", label: "Truck seller rule" },
      ],
      defaultSellingWeekdays: [1, 2, 3, 4, 5, 6],
    },
    positions: [
      {
        positionId: "kas",
        code: "KAS",
        label: "Key Account Specialist (KAS)",
        category: "field",
        standard: {
          dailyCallsTarget: 5,
          productiveCallTargetPct: 90,
          productiveCallRule: "any_listed_activity",
          sellingWeekdays: [1, 2, 3, 4, 5, 6],
          sourceRef: SOURCE,
          notes: "Productive % TO CONFIRM",
        },
      },
      {
        positionId: "pmot",
        code: "PMOT",
        label: "PMOT (Public Market and Open Trade)",
        category: "field",
        standard: {
          dailyCallsTarget: 30,
          productiveCallTargetPct: 85,
          productiveCallRule: "truck_seller",
          sellingWeekdays: [1, 2, 3, 4, 5, 6],
          sourceRef: SOURCE,
        },
      },
      {
        positionId: "ds",
        code: "DS",
        label: "Distributor Specialist",
        category: "specialist",
        standard: {
          workWithWeeklyMin: 4,
          workWithMonthlyMin: 16,
          sourceRef: "memo 2026-01-20 §III",
        },
      },
      {
        positionId: "head",
        code: "SALES_HEAD",
        label: "Sales Head",
        category: "leadership",
        standard: null,
      },
    ],
  }),
}));

describe("position standards panel", () => {
  it("shows each position's targets, rule, six-day week and source", () => {
    const html = renderToStaticMarkup(<PositionStandardsPanel />);
    expect(html).toContain("5 calls a day · 90% productive");
    expect(html).toContain("30 calls a day · 85% productive");
    expect(html).toContain("Truck seller rule");
    expect(html).toContain("Selling days Mon–Sat");
    expect(html).toContain(SOURCE);
    expect(html).toContain("TO CONFIRM");
    expect(html).toContain("Work With 4/week · 16/month");
    // A position without numbers is not listed as if it had a target.
    expect(html).not.toContain("Sales Head");
  });

  it("explains the any-one-activity productive call", () => {
    const html = renderToStaticMarkup(<PositionStandardsPanel />);
    expect(html).toContain("any one of these");
    expect(html).toContain("Suggested order (ICO)");
    expect(html).toContain("Bad order (BO) pickup");
    expect(html).toContain("no sales due to");
  });

  it("labels selling weeks", () => {
    expect(sellingWeekLabel([6, 1, 2, 3, 4, 5])).toBe("Mon–Sat");
    expect(sellingWeekLabel([1, 3])).toBe("Mon, Wed");
    expect(sellingWeekLabel([])).toBe("No selling days");
  });
});
