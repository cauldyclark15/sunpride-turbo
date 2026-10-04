import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

const at = (hhmm: string) => Date.parse(`2026-09-30T${hhmm}:00+08:00`);

const base = {
  employeeCode: null,
  positionLabel: "Route Distribution Salesman (RDS)",
  orgUnitId: "u1",
  sellingDay: true,
  scheduled: true,
  active: true,
  inField: false,
  planned: 3,
  plannedDone: 2,
  plannedOutlets: 3,
  coveredOutlets: 2,
  calls: 2,
  productiveCalls: 1,
  unplanned: 1,
  callsTarget: 30,
  productiveTargetPct: 85,
  sales: 1_000_50,
  salesTarget: 2_000_00,
  firstCheckInAt: at("10:00"),
  lastActivityAt: at("12:30"),
};
const ana = { ...base, profileId: "p1", name: "Ana", channel: "Route" };
const kim = {
  ...base,
  profileId: "p2",
  name: "Kim",
  channel: "KAS",
  scheduled: false,
  active: false,
  planned: 0,
  plannedDone: 0,
  plannedOutlets: 0,
  coveredOutlets: 0,
  calls: 0,
  productiveCalls: 0,
  unplanned: 0,
  callsTarget: 5,
  productiveTargetPct: 90,
  sales: 250_00,
  salesTarget: 1_000_00,
  firstCheckInAt: null,
  lastActivityAt: null,
};

vi.mock("convex/react", async () => {
  const model = await import("../../lib/execution-dashboard");
  const page = (page: number, rows: unknown[]) => ({
    serviceDate: "2026-09-30",
    page,
    pageCount: 2,
    pageSize: 1,
    peopleInScope: 2,
    truncated: false,
    units: [],
    channels: ["KAS", "Route"],
    rows,
    totals: model.summarize(rows as never),
  });
  return {
    useQuery: (ref: unknown) => {
      const name = getFunctionName(ref as never);
      if (name === "supervision/team:options")
        return {
          canDecide: true,
          units: [
            { id: "u1", code: "A", name: "Region A" },
            { id: "u2", code: "B", name: "Region B" },
          ],
          channels: ["KAS", "Route"],
        };
      if (name === "analytics/execution:day") return page(0, [ana]);
      if (name === "analytics/execution:exceptions")
        return {
          serviceDate: "2026-09-30",
          truncated: false,
          total: 3,
          open: 1,
          kinds: [
            { kind: "location", total: 1, open: 1 },
            { kind: "not_visited", total: 2, open: 0 },
          ],
          items: [
            {
              id: "location:e1",
              kind: "location",
              open: true,
              profileId: "p1",
              personName: "Ana",
              outletCode: "O1",
              outletName: "Outlet 1",
              at: at("10:00"),
              reason: null,
            },
          ],
        };
      return undefined;
    },
    useQueries: (requests: Record<string, { args: { page: number } }>) =>
      Object.fromEntries(
        Object.entries(requests).map(([key, request]) => [
          key,
          page(request.args.page, [kim]),
        ]),
      ),
  };
});

import { ExecutionDashboard } from "./execution-dashboard";

describe("daily execution dashboard", () => {
  it("adds every page and shows the six headline figures", () => {
    const html = renderToStaticMarkup(createElement(ExecutionDashboard));
    // Both pages are counted: Ana from page 0 and Kim from page 1.
    expect(html).toContain("Ana");
    expect(html).toContain("Kim");
    for (const label of [
      "Sales",
      "Call target",
      "Productive calls",
      "Coverage",
      "Active field force",
      "Exceptions",
    ])
      expect(html).toContain(label);
    // ₱1,000.50 + ₱250 against ₱2,000 + ₱1,000 → 41%.
    expect(html).toContain("₱1,251");
    expect(html).toContain("41% of ₱3,000 target");
    expect(html).toContain("2 of 35 calls");
    expect(html).toContain("1 of 2 calls · target 85%");
    expect(html).toContain("2 of 3 planned outlets");
    expect(html).toContain("1/1");
    expect(html).toContain("1 to review");
    // Per-channel view, key exceptions and filters for the caller's scope.
    expect(html).toContain("By channel");
    expect(html).toContain("Key exceptions");
    expect(html).toContain("Location 1 · 1 open");
    expect(html).toContain("Not visited 2");
    expect(html).toContain("O1 Outlet 1");
    expect(html).toContain("Region B");
    expect(html).toContain("My team only");
    expect(html).toContain("Provisional KPI definitions");
  });
});
