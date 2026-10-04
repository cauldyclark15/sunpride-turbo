import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as server from "../../../../../packages/backend/convex/analytics/compliance_model";
import {
  combineWeeks,
  complianceRows,
  coverageVerdict,
  DEFAULT_WEEKS,
  emptyWeek,
  MAX_WEEKS,
  MIN_WEEKS,
  PERSISTENT_WEEKS,
  rankByCoverage,
  ratePct,
  UNDER_COVERAGE_PCT,
  weekCompliancePct,
  type PersonResult,
  type WeekFigures,
} from "../../lib/coverage-compliance";

let permissions: { capabilities: string[] } | undefined;
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => permissions,
}));

import {
  CoverageCompliance,
  CoverageComplianceView,
} from "./coverage-compliance";

const wk = (done: number, missed: number, pending = 0): WeekFigures => ({
  planned: done + missed + pending,
  done,
  missed,
  pending,
});

const windows = [
  {
    weekStart: "2026-09-07",
    from: "2026-09-07",
    to: "2026-09-13",
    closed: true,
  },
  {
    weekStart: "2026-09-14",
    from: "2026-09-14",
    to: "2026-09-20",
    closed: true,
  },
  {
    weekStart: "2026-09-21",
    from: "2026-09-21",
    to: "2026-09-27",
    closed: true,
  },
  {
    weekStart: "2026-09-28",
    from: "2026-09-28",
    to: "2026-09-30",
    closed: false,
  },
];

// Ana misses O2 every week (T-A); Ben covers O2 in week 2 too and O3 (T-B) fully.
const ana: PersonResult = {
  profileId: "p-ana",
  name: "Ana",
  employeeCode: "E-1",
  positionLabel: "Route Salesman",
  windows,
  weeks: [wk(1, 1), wk(1, 1), wk(1, 1), wk(1, 0, 1)],
  offPlanVisits: [0, 2, 0, 0],
  territories: [
    {
      territoryId: "t-a",
      code: "T-A",
      name: "North",
      weeks: [wk(1, 1), wk(1, 1), wk(1, 1), wk(1, 0, 1)],
    },
  ],
  outlets: [
    {
      outletId: "o1",
      code: "O1",
      name: "Store One",
      territoryCode: "T-A",
      customerCode: "C1",
      customerName: "Customer One",
      weeks: [wk(1, 0), wk(1, 0), wk(1, 0), wk(1, 0)],
    },
    {
      outletId: "o2",
      code: "O2",
      name: "Store Two",
      territoryCode: "T-A",
      customerCode: null,
      customerName: null,
      weeks: [wk(0, 1), wk(0, 1), wk(0, 1), wk(0, 0, 1)],
    },
  ],
  outletsTruncated: false,
};
const ben: PersonResult = {
  profileId: "p-ben",
  name: "Ben",
  employeeCode: null,
  positionLabel: null,
  windows,
  weeks: [wk(2, 0), wk(3, 0), wk(2, 0), emptyWeek()],
  offPlanVisits: [0, 0, 0, 0],
  territories: [
    {
      territoryId: "t-a",
      code: "T-A",
      name: "North",
      weeks: [emptyWeek(), wk(1, 0), emptyWeek(), emptyWeek()],
    },
    {
      territoryId: "t-b",
      code: "T-B",
      name: "South",
      weeks: [wk(2, 0), wk(2, 0), wk(2, 0), emptyWeek()],
    },
  ],
  outlets: [
    {
      outletId: "o2",
      code: "O2",
      name: "Store Two",
      territoryCode: "T-A",
      customerCode: null,
      customerName: null,
      weeks: [emptyWeek(), wk(1, 0), emptyWeek(), emptyWeek()],
    },
  ],
  outletsTruncated: false,
};

describe("coverage compliance rules (web mirror)", () => {
  it("matches the server's constants, sums, verdicts and ranking", () => {
    expect([
      DEFAULT_WEEKS,
      MAX_WEEKS,
      MIN_WEEKS,
      UNDER_COVERAGE_PCT,
      PERSISTENT_WEEKS,
    ]).toEqual([
      server.DEFAULT_WEEKS,
      server.MAX_WEEKS,
      server.MIN_WEEKS,
      server.UNDER_COVERAGE_PCT,
      server.PERSISTENT_WEEKS,
    ]);
    expect(Object.keys(emptyWeek()).sort()).toEqual(
      Object.keys(server.emptyWeek()).sort(),
    );
    expect(ratePct(2, 3)).toBe(server.ratePct(2, 3));
    const series = [ana.weeks, ben.weeks, ana.outlets[1]!.weeks];
    expect(combineWeeks(series)).toEqual(server.combineWeeks(series));
    for (const row of [...series, combineWeeks(series)]) {
      expect(coverageVerdict(row, windows)).toEqual(
        server.coverageVerdict(row, windows),
      );
      for (const week of row)
        expect(weekCompliancePct(week)).toBe(server.weekCompliancePct(week));
    }
    const ranked = series.map((weeks, i) => ({
      code: `R${i}`,
      verdict: coverageVerdict(weeks, windows),
    }));
    expect(rankByCoverage(ranked).map((r) => r.code)).toEqual(
      server.rankByCoverage(ranked).map((r) => r.code),
    );
  });

  it("sums people into territory and store rows, worst first", () => {
    const employees = complianceRows([ben, ana], "employee");
    expect(employees.map((r) => r.name)).toEqual(["Ana", "Ben"]);
    expect(employees[0]!.verdict).toMatchObject({
      persistent: true,
      streak: 3,
    });
    expect(employees[0]!.offPlanVisits).toBe(2);

    const territories = complianceRows([ana, ben], "territory");
    expect(territories.map((r) => r.code)).toEqual(["T-A", "T-B"]);
    // Week 2 of T-A: Ana 1/2 plus Ben 1/1 = 2/3 → 66%, still under.
    expect(weekCompliancePct(territories[0]!.weeks[1]!)).toBe(66);
    expect(territories[0]!.people).toEqual(["Ana", "Ben"]);
    expect(territories[0]!.verdict.persistent).toBe(true);
    expect(territories[1]!.verdict.compliancePct).toBe(100);

    const stores = complianceRows([ana, ben], "customer");
    expect(stores.map((r) => r.code)).toEqual(["O2", "O1"]);
    // Ben's week-2 visit lifts O2 to 1 of 2 (50%): still under, so the run holds.
    expect(weekCompliancePct(stores[0]!.weeks[1]!)).toBe(50);
    expect(stores[0]!.verdict).toMatchObject({
      underWeeks: 3,
      streak: 3,
      persistent: true,
    });
    expect(stores[1]!.verdict.underWeeks).toBe(0);
    expect(stores[1]!.detail).toBe("O1 · C1 Customer One · T-A");
  });
});

const roster = {
  truncated: false,
  directReports: 0,
  people: [
    { profileId: "p-ana" },
    { profileId: "p-ben" },
    { profileId: "p-cara" },
  ],
};

function render(
  over: Partial<Parameters<typeof CoverageComplianceView>[0]> = {},
) {
  return renderToStaticMarkup(
    <CoverageComplianceView
      // Test doubles: ids are plain strings here.
      roster={roster as never}
      results={[ana, ben]}
      view="employee"
      onView={() => {}}
      weeks={4}
      onWeeks={() => {}}
      persistentOnly={false}
      onPersistentOnly={() => {}}
      endDate="2026-09-30"
      {...over}
    />,
  );
}

describe("CoverageComplianceView", () => {
  it("shows weekly compliance with the persistent rows first", () => {
    const html = render();
    expect(html).toContain("Coverage compliance");
    expect(html).toContain("Loading 1…");
    expect(html.indexOf(">Ana<")).toBeLessThan(html.indexOf(">Ben<"));
    expect(html).toContain("Persistent · 3 weeks");
    expect(html).toContain("(open)");
    expect(html).toContain("1/1 +1 open");
    // 11 of 14 due stops across both people (pending stops are not due yet).
    expect(html).toContain("11 of 14 due stops visited");
    expect(html).toContain("2 visits outside the plan");
    expect(html).toContain("provisional");
  });

  it("switches to stores and filters persistent rows", () => {
    const stores = render({ view: "customer" });
    expect(stores).toContain("Store Two");
    expect(stores).toContain("Ana, Ben");
    const persistent = render({ view: "territory", persistentOnly: true });
    expect(persistent).toContain("North");
    expect(persistent).not.toContain(">South<");
    const persistentStores = render({ view: "customer", persistentOnly: true });
    expect(persistentStores).toContain("Store Two");
    expect(persistentStores).not.toContain("Store One");
    expect(
      render({
        roster: { ...roster, people: [{ profileId: "p-ben" }] } as never,
        results: [ben],
        view: "customer",
        persistentOnly: true,
      }),
    ).toContain("No persistent under-coverage");
  });

  it("stays hidden without the reading capabilities", () => {
    permissions = { capabilities: ["report.read"] };
    expect(renderToStaticMarkup(<CoverageCompliance />)).toBe("");
    permissions = undefined;
    expect(renderToStaticMarkup(<CoverageCompliance />)).toBe("");
  });
});
