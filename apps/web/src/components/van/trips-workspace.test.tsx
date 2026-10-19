import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  VanTripsView,
  VanTripDetail,
  pesos,
  tripCsv,
  settlementLabel,
} from "./trips-workspace";
import type { TripSettlement, TripsDay } from "./model";

vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(),
  useApi: vi.fn(),
  useLive: vi.fn(),
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("../van-cash-approval", () => ({ VanCashApproval: () => null }));
vi.mock("../van-stock-approval", () => ({ VanStockApproval: () => null }));
vi.mock("../van-void-approval", () => ({ VanVoidApproval: () => null }));
vi.mock("../van-damage-approvals", () => ({ VanDamageApprovals: () => null }));
vi.mock("@heroui/react", () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    createElement("button", null, children),
}));

const quantity = (base: string, display: string) => ({
  base,
  cases: 0,
  pieces: 0,
  display,
});
const trip: TripSettlement = {
  tripId: "trip",
  tripNumber: "TRIP-001",
  date: "2026-10-19",
  unitId: "unit",
  unit: "Cebu",
  truck: "Truck 1",
  plateNumber: "SAMPLE",
  seller: "Sample seller",
  route: "North Cebu",
  status: "reconciling",
  settlementStatus: "needs_review",
  startedAt: 1,
  closedAt: null,
  unclosed: true,
  salesCentavos: 100200,
  discountsCentavos: 0,
  stock: [
    {
      productId: "product",
      code: "SAMPLE",
      name: "Sample corned beef",
      uomCode: "PC",
      loaded: quantity("48", "4 cases + 0 pieces"),
      sold: quantity("12", "1 cases + 0 pieces"),
      voided: quantity("4", "0 cases + 4 pieces"),
      returned: quantity("2", "0 cases + 2 pieces"),
      damaged: quantity("0", "0 cases + 0 pieces"),
      unloaded: quantity("0", "0 cases + 0 pieces"),
      expected: quantity("42", "3 cases + 6 pieces"),
      expectedAvailable: quantity("42", "3 cases + 6 pieces"),
      expectedDamaged: quantity("0", "0 cases + 0 pieces"),
      counted: quantity("41", "3 cases + 5 pieces"),
      variance: quantity("-1", "−0 cases + 1 pieces"),
      varianceCentavos: -10000,
      countLines: [],
    },
  ],
  cash: {
    expectedCentavos: 100200,
    cashSalesCentavos: 150300,
    collectionsCentavos: 0,
    refundsCentavos: 50100,
    remittedCentavos: 90000,
    varianceCentavos: -10200,
    reason: "counting_error",
    approvedBy: "Maria Supervisor",
    countedAt: 1,
  },
  stockCount: {
    countCode: "ABCDEF123456",
    varianceLines: 1,
    shortBase: "1",
    overBase: "0",
    approvedBy: "Maria Supervisor",
    countedAt: 1,
  },
  loads: [],
  sales: [
    {
      saleId: "sale",
      receiptNumber: "TRIP-001-AABBCCDD-0001",
      totalCentavos: 50100,
      receipt: {
        customer: { name: "Original shop name" },
        lines: [
          {
            name: "Original product name",
            code: "SAMPLE",
            quantityBase: "4",
            uomCode: "PC",
            totalMinor: "50100",
          },
        ],
      },
      voided: true,
      voidReason: "wrong_items",
      approvedBy: "Maria Supervisor",
    },
  ],
  returns: [],
  payments: [],
  history: [],
  nextAction: "Review differences and close the trip",
};
const data: TripsDay = {
  date: "2026-10-19",
  asOf: 1792368000000,
  targetCentavos: null,
  targetStatus: "needs_setup",
  priorDate: "2026-10-18",
  priorSalesCentavos: 50000,
  trend: [
    { date: "2026-10-18", salesCentavos: 50000 },
    { date: "2026-10-19", salesCentavos: 100200 },
  ],
  rows: [trip],
};
const view = (d = data) =>
  renderToStaticMarkup(
    createElement(VanTripsView, {
      data: d,
      selected: null,
      onSelect: () => {},
    }),
  );
describe("owner truck settlement", () => {
  it("puts variance exceptions first, compares prior day, shows trend and needs-setup target", () => {
    const html = view();
    expect(html).toContain("trip needs a variance review");
    expect(html).toContain("Prior day");
    expect(html).toContain("₱500.00");
    expect(html).toContain("Sales trend");
    expect(html).toContain("Needs setup");
    expect(html).toContain("Set targets");
    expect(html).toContain("Review differences and close the trip");
  });
  it("distinguishes no count from zero rather than certifying a missing hand-in", () => {
    const html = view({
      ...data,
      rows: [
        {
          ...trip,
          cash: {
            ...trip.cash,
            remittedCentavos: null,
            varianceCentavos: null,
          },
          stockCount: null,
        },
      ],
    });
    expect(html).toContain("Not counted");
    expect(pesos(0)).toBe("₱0.00");
    expect(pesos(null)).toBe("Not counted");
  });
  it("drills from truck to load, frozen receipt, stock and cash facts with approver attribution", () => {
    const html = renderToStaticMarkup(createElement(VanTripDetail, { trip }));
    expect(html).toContain("3 cases + 6 pieces");
    expect(html).toContain("3 cases + 5 pieces");
    expect(html).toContain("Maria Supervisor");
    expect(html).toContain("Original shop name");
    expect(html).toContain("Original product name");
    expect(html).toContain("Export trip CSV");
    expect(html).toContain("Print settlement");
    expect(html).toContain("₱102.00");
    expect(html).not.toContain("counting_error");
  });
  it("exports RFC-4180, BOM, all stock/cash/void facts and formula-protects cells", () => {
    const csv = tripCsv({
      ...trip,
      truck: '=HYPERLINK("bad")',
      stock: [{ ...trip.stock[0]!, name: 'A,"B"' }],
    });
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"A,""B"""');
    expect(csv).toContain('"3 cases + 6 pieces"');
    expect(csv).toContain('"Maria Supervisor"');
    expect(csv).toContain('"100200"');
    expect(csv).toContain("\r\n");
  });
  it("shows an actionable empty day and no stale trip detail", () => {
    const html = view({ ...data, rows: [], trend: [] });
    expect(html).toContain("No trips planned for this day");
    expect(html).toContain("No trips in this period");
    expect(html).not.toContain("Maria Supervisor");
    expect(settlementLabel("review_required")).toBe("Needs review");
  });
  it("keeps unknown stock value distinct from a measured zero variance", () => {
    const html = renderToStaticMarkup(
      createElement(VanTripDetail, {
        trip: {
          ...trip,
          stock: [{ ...trip.stock[0]!, varianceCentavos: null }],
        },
      }),
    );
    expect(html).toContain("Cost not set");
    expect(html).not.toContain("value_centavos");
  });
});
