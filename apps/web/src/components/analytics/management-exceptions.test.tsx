import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

const now = Date.parse("2026-09-30T07:00:00Z");
const at = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00+08:00`);

const anaRow = {
  profileId: "p1",
  name: "Ana",
  employeeCode: "E-1",
  positionLabel: "RDS",
  channel: "Route",
  direct: true,
  plannedClosed: 6,
  doneClosed: 3,
  planPct: 50,
  sales: 5_000_00,
  salesTarget: 25_000_00,
  salesPct: 20,
  reasons: ["plan", "sales"],
  missedHighValueCount: 1,
  missedHighValue: [
    {
      plannedVisitId: "pv1",
      outletId: "o1",
      outletCode: "HV1",
      outletName: "Big Mart",
      classification: "A",
      serviceDate: "2026-09-29",
    },
  ],
  truncated: false,
};
const kimRow = {
  ...anaRow,
  profileId: "p2",
  name: "Kim",
  channel: "KAS",
  reasons: [],
  planPct: null,
  salesPct: null,
  salesTarget: null,
  missedHighValueCount: 1,
  missedHighValue: [
    {
      ...anaRow.missedHighValue[0],
      plannedVisitId: "pv2",
      outletCode: "HV2",
      outletName: "Key Store",
    },
  ],
};
const totals = (behind: number) => ({
  people: 3,
  behind,
  behindPlan: behind,
  behindSales: behind,
  missedHighValue: 1,
  peopleMissingHighValue: 1,
});

const calls: { name: string; args: unknown }[] = [];

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    calls.push({ name, args });
    if (name === "supervision/team:options")
      return {
        canDecide: true,
        units: [
          { id: "u1", code: "A", name: "Region A" },
          { id: "u2", code: "B", name: "Region B" },
        ],
        channels: ["KAS", "Route"],
      };
    if (name === "analytics/exceptions:field")
      return {
        from: "2026-09-01",
        to: "2026-09-30",
        page: 0,
        pageCount: 2,
        peopleInScope: 4,
        truncated: false,
        sourceRef: "test",
        rows: [anaRow],
        totals: totals(1),
      };
    if (name === "analytics/exceptions:geofence")
      return {
        from: "2026-09-01",
        to: "2026-09-30",
        truncated: false,
        issues: 4,
        open: 2,
        people: [
          {
            profileId: "p1",
            name: "Ana",
            channel: "Route",
            issues: 4,
            open: 2,
            outlets: 1,
            mock: 1,
            lastAt: at("2026-09-28", "10:00"),
          },
        ],
        outlets: [
          {
            outletId: "o1",
            outletCode: "HV1",
            outletName: "Big Mart",
            issues: 4,
            people: 1,
            lastAt: at("2026-09-28", "10:00"),
          },
        ],
      };
    if (name === "analytics/exceptions:operations")
      return {
        from: "2026-09-01",
        to: "2026-09-30",
        sap: {
          available: true,
          truncated: false,
          failed: 1,
          deadLetter: 0,
          stuck: 1,
          connectorsDown: [],
          items: [
            {
              eventId: "e1",
              kind: "failed",
              direction: "outbound",
              eventType: "inventory.movement",
              attempts: 3,
              receivedAt: at("2026-09-29", "09:00"),
              documentRef: "DOC-1",
              lastError: "SAP timeout",
            },
          ],
        },
        trips: {
          available: true,
          truncated: false,
          items: [
            {
              routeSessionId: "r1",
              routeCode: "R-OLD",
              truckCode: "TRK-A",
              salespersonName: "Ana",
              status: "open",
              openedAt: at("2026-09-28", "06:00"),
            },
          ],
        },
        stock: { available: false, reason: "Needs inventory read access" },
        cash: { tracked: false, reason: "Cash remittance is not recorded." },
      };
    if (name === "analytics/exceptions:outOfStock")
      return {
        from: "2026-09-01",
        to: "2026-09-30",
        truncated: false,
        findings: 5,
        outletsAffected: 3,
        outlets: [
          {
            outletId: "o1",
            outletCode: "HV1",
            outletName: "Big Mart",
            findings: 3,
            products: 2,
            lastDate: "2026-09-20",
          },
        ],
        products: [
          {
            productId: "pr1",
            productCode: "P1",
            productName: "Corned beef",
            outlets: 3,
            findings: 4,
          },
        ],
        units: [
          { orgUnitId: "u1", name: "Region A", findings: 4 },
          { orgUnitId: "u2", name: "Region B", findings: 1 },
        ],
      };
    return undefined;
  },
  useQueries: (requests: Record<string, { args: { page: number } }>) =>
    Object.fromEntries(
      Object.entries(requests).map(([key, request]) => [
        key,
        {
          from: "2026-09-01",
          to: "2026-09-30",
          page: request.args.page,
          pageCount: 2,
          peopleInScope: 4,
          truncated: false,
          sourceRef: "test",
          rows: [kimRow],
          totals: totals(0),
        },
      ]),
    ),
}));

import { ManagementExceptions } from "./management-exceptions";

describe("management exception dashboard", () => {
  it("shows every exception list for the scope, adding all field pages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    calls.length = 0;
    const html = renderToStaticMarkup(createElement(ManagementExceptions));
    vi.useRealTimers();
    for (const label of [
      "Exceptions to manage",
      "Missed high-value outlets",
      "Behind plan",
      "Repeated location issues",
      "SAP failures",
      "Unclosed trips",
      "Stock variances",
      "Cash variances",
      "Out-of-stock hotspots",
    ])
      expect(html).toContain(label);
    // Month to date by default, and both field pages are shown.
    expect(calls).toContainEqual({
      name: "analytics/exceptions:field",
      args: { from: "2026-09-01", to: "2026-09-30", page: 0 },
    });
    expect(html).toContain("Big Mart");
    expect(html).toContain("Key Store");
    expect(html).toContain("Sep 29");
    expect(html).toContain("3/6 · 50%");
    expect(html).toContain("20% of ₱25,000");
    expect(html).toContain("Behind on plan");
    expect(html).toContain("Behind on sales");
    expect(html).toContain("Fake location signal 1");
    expect(html).toContain("4 · 2 to review");
    expect(html).toContain("Failed 1");
    expect(html).toContain("SAP timeout");
    expect(html).toContain("R-OLD");
    expect(html).toContain("57 h ago");
    expect(html).toContain("Needs inventory read access.");
    expect(html).toContain("Cash remittance is not recorded.");
    expect(html).toContain("Corned beef");
    expect(html).toContain("Region A 4");
    expect(html).toContain("My team only");
    expect(html).toContain("provisional until Sunpride confirms");
  });
});
