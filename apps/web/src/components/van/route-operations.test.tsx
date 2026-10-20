import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { routeBase, routeMoney, routeQuantity } from "./route-format";
import { WarehouseUnloadReceipt } from "./warehouse-unload-receipt";
import { RouteScorecardView, type RouteScorecard } from "./route-scorecard";
import type { RouteOperations } from "./route-operations";
vi.mock("@heroui/react", () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    createElement("button", null, children),
}));

describe("F-102 F-104 exact quantities and frozen units", () => {
  it("does not round a reviewed load into a different scaled quantity", () => {
    expect(routeBase("1.125", "1000")).toBe("1125");
    expect(() => routeBase("0.001", "100")).toThrow();
    expect(() => routeBase("-1", "1")).toThrow();
  });
  it("shows cases and pieces rather than raw scaled counts", () => {
    expect(routeQuantity("25000", "1000", "12000", "pieces")).toBe(
      "2 cases + 1 pieces",
    );
    expect(routeMoney("12345")).toBe("₱123.45");
    expect(routeMoney(null)).toBe("Value needs review");
  });
});
it("F-116 warehouse receipt keeps two sold batches distinct and includes empties", () => {
  const line = {
    productId: "private-product",
    status: "available",
    quantityBase: "12000",
    partition: "unsold",
    expiresAt: 1794000000000,
    qualityStatus: "released",
    product: {
      name: "Sample frozen goods",
      quantityScale: "1000",
      caseBase: "12000",
      uomCode: "pieces",
    },
  };
  const observation: RouteOperations["observations"][number] = {
    id: "private-observation",
    kind: "unload",
    outletName: null,
    capturedAt: "2026-10-20T10:00:00Z",
    decision: null,
    facts: {
      lines: [
        { ...line, lotId: "private-lot-a", batch: "A" },
        { ...line, lotId: "private-lot-b", batch: "B" },
      ],
      empties: [{ typeCode: "crate", label: "Sample crate", quantity: "11" }],
    },
  };
  const html = renderToStaticMarkup(
    <WarehouseUnloadReceipt
      observation={observation}
      tripId="private-trip"
      note="Counted"
      busy={false}
      reviewer
      onReceive={async () => {}}
    />,
  );
  expect(html).toContain("batch A");
  expect(html).toContain("batch B");
  expect(html).toContain("1 cases + 0 pieces");
  expect(html).toContain("Sample crate");
  expect(html).not.toContain("private-lot");
  expect(html).not.toContain("private-product");
  expect(html).not.toContain("scaled base units");
});
it("F-122 scorecard states missing stop facts and target rather than asserting a perfect day", () => {
  const card: RouteScorecard = {
    salesCentavos: "100",
    calls: 0,
    plannedCalls: 2,
    productiveCalls: 0,
    strikeRateBasisPoints: null,
    dropSizeCentavos: "100",
    returnDocuments: 1,
    refundsCentavos: "0",
    varianceCentavos: null,
    collectedCentavos: "100",
    callFactsComplete: false,
    definitions: "Sample definitions",
    monthSalesCentavos: "100",
    monthTargetCentavos: null,
    targetStatus: "needs_setup",
    prior: { date: "2026-10-19", salesCentavos: "200" },
    trend: [{ date: "2026-10-20", salesCentavos: "100" }],
  };
  const html = renderToStaticMarkup(<RouteScorecardView card={card} />);
  expect(html).toContain("missing actual stop facts");
  expect(html).toContain("Set an unambiguous monthly target");
  expect(html).toContain("Previous trip 2026-10-19");
  expect(html).not.toContain("100%");
});
