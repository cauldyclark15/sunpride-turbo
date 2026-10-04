import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as server from "../../../../../packages/backend/convex/analytics/customer_model";
import {
  changeText,
  daysText,
  lastOrderTone,
  MAX_CUSTOMER_WEEKS,
  WEEK_PRESETS,
  weekLabel,
} from "../../lib/customer-execution";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
}));

import { CustomerExecutionView } from "./customer-execution";

type Data = Parameters<typeof CustomerExecutionView>[0]["data"];

const week = (
  weekStart: string,
  over: Partial<Data["weeks"][number]> = {},
) => ({
  weekStart,
  visitDays: 1,
  visits: 1,
  unplannedVisits: 0,
  planned: 1,
  plannedDone: 1,
  missed: 0,
  orders: 1,
  sales: 100_000,
  ...over,
});

const data = (over: Partial<Data> = {}): Data => ({
  outlet: {
    outletId: "o1" as Data["outlet"]["outletId"],
    code: "O-001",
    name: "Aling Nena Store",
    status: "active",
    channel: "General Trade",
    classification: null,
    unitName: "Region A",
    territory: "T-A · Territory A",
    route: "R-1",
  },
  customer: { code: "C1", name: "Nena Trading", sharedWithOtherOutlets: true },
  from: "2026-09-02",
  to: "2026-09-29",
  weeks: [
    week("2026-09-02"),
    week("2026-09-09", { unplannedVisits: 2 }),
    week("2026-09-16", { orders: 0, sales: 0 }),
    week("2026-09-23", { planned: 2, plannedDone: 0, missed: 1, visitDays: 0 }),
  ],
  regularity: {
    visitDays: 3,
    lastVisitDate: "2026-09-16",
    daysSinceLastVisit: 13,
    expectedCycleDays: 7,
    averageGapDays: 7,
    longestGapDays: 7,
    gaps: 2,
    gapsOnCadence: 2,
    onCadencePct: 100,
    status: "overdue",
  },
  plannedCalls: {
    planned: 5,
    done: 3,
    missed: 1,
    pending: 1,
    missedPct: 25,
    recentMissed: [
      { serviceDate: "2026-09-26", assigneeName: "Ana Cruz", route: "R-1" },
    ],
  },
  orders: {
    orders: 3,
    sales: 300_000,
    averageOrder: 100_000,
    lastOrderDate: "2026-09-09",
    lastOrderAmount: 100_000,
    daysSinceLastOrder: 20,
    recentSales: 300_000,
    recentOrders: 3,
    priorSales: 600_000,
    changePct: -50,
    direction: "down",
    skusBought: 4,
  },
  assortment: {
    hasAssortment: true,
    required: 2,
    ordered: 1,
    distributionPct: 50,
    checked: 2,
    available: 1,
    outOfStock: 1,
    notCarried: 0,
    availabilityPct: 50,
    gaps: 1,
    lastAuditDate: "2026-09-16",
    skus: [
      {
        productId: "p1" as Data["assortment"]["skus"][number]["productId"],
        code: "SP-PJ-1L",
        name: "Pineapple Juice 1L",
        ordered: true,
        lastOrderedDate: "2026-09-09",
        availability: "available",
        facings: 4,
      },
      {
        productId: "p2" as Data["assortment"]["skus"][number]["productId"],
        code: "SP-FC-850",
        name: "Fruit Cocktail 850g",
        ordered: false,
        lastOrderedDate: null,
        availability: "out_of_stock",
        facings: null,
      },
    ],
  },
  truncated: false,
  sourceRef: server.CUSTOMER_SOURCE,
  ...over,
});

describe("customer execution helpers", () => {
  it("keeps the period limit equal to the server's", () => {
    expect(MAX_CUSTOMER_WEEKS).toBe(server.MAX_CUSTOMER_WEEKS);
    for (const [weeks] of WEEK_PRESETS)
      expect(server.weeksError(weeks)).toBeNull();
  });

  it("formats days, changes and weeks", () => {
    expect(daysText(null)).toBe("—");
    expect(daysText(0)).toBe("Today");
    expect(daysText(1)).toBe("1 day");
    expect(daysText(9)).toBe("9 days");
    expect(changeText(12)).toBe("+12%");
    expect(changeText(-4)).toBe("-4%");
    expect(changeText(null)).toBe("—");
    expect(weekLabel("2026-09-02")).toMatch(/Sep\s+2/);
    expect(lastOrderTone(null, 7)).toBe("danger");
    expect(lastOrderTone(15, 7)).toBe("warning");
    expect(lastOrderTone(14, 7)).toBe("neutral");
    expect(lastOrderTone(15, null)).toBe("warning");
  });
});

describe("CustomerExecutionView", () => {
  it("shows regularity, order trend, days since last order, missed calls and distribution", () => {
    const html = renderToStaticMarkup(<CustomerExecutionView data={data()} />);
    for (const text of [
      "Aling Nena Store",
      "Customer C1 · Nena Trading",
      "Visit regularity",
      "Overdue",
      "every 7 days expected",
      "Days since last order",
      "20 days",
      "Order trend (last 4 weeks)",
      "-50%",
      "Declining",
      "Missed planned calls",
      "1 still due",
      "Distribution",
      "1 of 2 required SKUs ordered",
      "On-shelf availability",
      "Week by week",
      "Recent missed planned calls",
      "Ana Cruz",
      "Pineapple Juice 1L",
      "Not ordered",
      "Out of stock",
      "4 facings",
      "also buys for other stores",
      "provisional",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Some records were left out");
  });

  it("explains empty figures instead of showing zeros as facts", () => {
    const html = renderToStaticMarkup(
      <CustomerExecutionView
        data={data({
          customer: null,
          truncated: true,
          regularity: {
            ...data().regularity,
            lastVisitDate: null,
            daysSinceLastVisit: null,
            expectedCycleDays: null,
            status: "not_visited",
          },
          orders: {
            ...data().orders,
            lastOrderDate: null,
            lastOrderAmount: null,
            daysSinceLastOrder: null,
            changePct: null,
            priorSales: null,
            direction: "none",
          },
          plannedCalls: { ...data().plannedCalls, recentMissed: [] },
          assortment: {
            ...data().assortment,
            hasAssortment: false,
            required: 0,
            distributionPct: null,
            availabilityPct: null,
            lastAuditDate: null,
            gaps: 0,
            skus: [],
          },
        })}
      />,
    );
    for (const text of [
      "No customer linked",
      "Not visited",
      "No visit on record",
      "No order on record",
      "No sales",
      "No required assortment set",
      "No merchandising audit yet",
      "4 SKU(s) bought in the period",
      "Some records were left out",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Recent missed planned calls");
  });
});
