import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as server from "../../../../../packages/backend/convex/analytics/productivity_model";
import {
  combineFigures,
  emptyFigures,
  MAX_PERIOD_DAYS,
  periodFor,
  pesoText,
  productivityFlags,
  ratePct,
  ratesOf,
  type PeriodFigures,
} from "../../lib/supervisor-productivity";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
}));

import { ProductivityView } from "./productivity";

const figures = (over: Partial<PeriodFigures>): PeriodFigures => ({
  ...emptyFigures(),
  days: 7,
  sellingDays: 6,
  ...over,
});

const ana = figures({
  planned: 20,
  plannedDone: 16,
  calls: 16,
  productiveCalls: 12,
  convertedCalls: 8,
  missed: 3,
  pending: 1,
  visits: 20,
  unplanned: 4,
  exceptionVisits: 6,
  locationExceptions: 2,
  outOfSequence: 1,
  orders: 9,
  sales: 1_600_000,
  callsTarget: 180,
});
const ben = figures({
  planned: 10,
  plannedDone: 10,
  calls: 10,
  productiveCalls: 10,
  convertedCalls: 2,
  visits: 10,
  orders: 2,
  sales: 200_000,
  callsTarget: 180,
});

describe("productivity rules (web mirror)", () => {
  it("matches the server's totals and rates", () => {
    const rows = [ana, ben, emptyFigures()];
    expect(combineFigures(rows)).toEqual(server.combineFigures(rows));
    for (const row of [...rows, combineFigures(rows)])
      expect(ratesOf(row)).toEqual(server.ratesOf(row));
    expect(ratePct(1, 3)).toBe(server.ratePct(1, 3));
    expect(MAX_PERIOD_DAYS).toBe(server.MAX_PERIOD_DAYS);
    expect(Object.keys(emptyFigures()).sort()).toEqual(
      Object.keys(server.emptyFigures()).sort(),
    );
  });

  it("sums people before dividing", () => {
    const team = combineFigures([ana, ben]);
    // 22 of 26 calls, not the mean of 75% and 100%.
    expect(ratesOf(team).productivePct).toBe(84);
    expect(team.callsTarget).toBe(360);
    expect(ratesOf(team).salesPerCall).toBe(69_231);
  });

  it("builds the period ending at the selected date", () => {
    expect(periodFor("7", "2026-09-29")).toEqual({
      from: "2026-09-23",
      to: "2026-09-29",
    });
    expect(periodFor("mtd", "2026-09-29")).toEqual({
      from: "2026-09-01",
      to: "2026-09-29",
    });
    expect(periodFor("31", "2026-03-02")).toEqual({
      from: "2026-01-31",
      to: "2026-03-02",
    });
    expect(server.periodError("2026-01-31", "2026-03-02")).toBeNull();
  });

  it("flags missed calls, productive below target and high exception rates", () => {
    expect(productivityFlags(ana, 85).map((f) => f.label)).toEqual([
      "3 missed",
      "Productive below 85%",
      "30% exceptions",
    ]);
    expect(productivityFlags(ben, 85)).toEqual([]);
    expect(productivityFlags(emptyFigures(), null)).toEqual([]);
  });
});

describe("productivity screen", () => {
  const person = (profileId: string, name: string, direct: boolean) => ({
    profileId,
    name,
    employeeCode: null,
    positionLabel: "Route Salesman",
    channel: "PMOT",
    direct,
  });
  const result = (profileId: string, name: string, f: PeriodFigures) => ({
    ...person(profileId, name, true),
    from: "2026-09-23",
    to: "2026-09-29",
    productiveCallTargetPct: 85,
    sourceRef: "test",
    figures: f,
    days: [],
  });
  const render = (sort: "name" | "conversion", loaded: boolean) =>
    renderToStaticMarkup(
      <ProductivityView
        roster={
          {
            truncated: false,
            directReports: 1,
            people: [person("p1", "Ana", true), person("p2", "Ben", false)],
          } as never
        }
        results={
          new Map(
            loaded
              ? [
                  ["p1", result("p1", "Ana", ana)],
                  ["p2", result("p2", "Ben", ben)],
                ]
              : [["p2", result("p2", "Ben", ben)]],
          ) as never
        }
        period={{ from: "2026-09-23", to: "2026-09-29" }}
        preset="7"
        onPreset={vi.fn()}
        sort={sort}
        onSort={vi.fn()}
        directOnly={false}
      />,
    );

  it("compares each person and the team on every figure", () => {
    const html = render("name", true);
    expect(html).toContain("Actual / planned calls");
    expect(html).toContain("26/30");
    expect(html).toContain("84%");
    expect(html).toContain("Order conversion");
    expect(html).toContain("38%"); // 10 of 26
    expect(html).toContain(pesoText(69_231));
    expect(html).toContain("Missed calls");
    expect(html).toContain("Exception rate");
    expect(html).toContain("20%"); // 6 of 30 visits
    expect(html).toContain("16/20");
    expect(html).toContain("3 missed");
    expect(html).toContain("Direct");
    expect(html).toContain("provisional");
    expect(html.indexOf("Ana")).toBeLessThan(html.indexOf("Ben"));
  });

  it("sorts worst first and shows people still loading", () => {
    // Lowest conversion first: Ben (20%) before Ana (50%).
    const sorted = render("conversion", true);
    expect(sorted.indexOf(">Ben<")).toBeLessThan(sorted.indexOf(">Ana<"));
    const partial = render("name", false);
    expect(partial).toContain("Loading 1…");
    expect(partial).toContain("10/10");
  });
});
