import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as server from "../../../../../packages/backend/convex/analytics/territory_model";
import {
  belowTarget,
  combineTerritoryFigures,
  emptyTerritoryFigures,
  MAX_PERIOD_DAYS,
  periodFor,
  pesoText,
  rankTerritories,
  ratePct,
  territoryRates,
  type TerritoryFigures,
} from "../../lib/territory-performance";

let permissions: { capabilities: string[] } | undefined;
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => permissions,
}));

import {
  TerritoryPerformance,
  TerritoryPerformanceView,
} from "./territory-performance";

const figures = (over: Partial<TerritoryFigures>): TerritoryFigures => ({
  ...emptyTerritoryFigures(),
  ...over,
});

const north = figures({
  activeOutlets: 40,
  buyingOutlets: 30,
  planned: 120,
  plannedOutlets: 40,
  coveredOutlets: 36,
  calls: 110,
  productiveCalls: 99,
  missed: 4,
  orders: 90,
  sales: 9_000_000,
  salesTarget: 12_000_000,
});
const south = figures({
  activeOutlets: 20,
  buyingOutlets: 19,
  planned: 60,
  plannedOutlets: 20,
  coveredOutlets: 20,
  calls: 60,
  productiveCalls: 48,
  orders: 50,
  sales: 6_000_000,
  salesTarget: 5_000_000,
});

describe("territory performance rules (web mirror)", () => {
  it("matches the server's totals, rates and ranking", () => {
    const rows = [north, south, emptyTerritoryFigures()];
    expect(combineTerritoryFigures(rows)).toEqual(
      server.combineTerritoryFigures(rows),
    );
    for (const row of [...rows, combineTerritoryFigures(rows)])
      expect(territoryRates(row)).toEqual(server.territoryRates(row));
    expect(ratePct(1, 3)).toBe(server.ratePct(1, 3));
    expect(MAX_PERIOD_DAYS).toBe(server.MAX_PERIOD_DAYS);
    expect(Object.keys(emptyTerritoryFigures()).sort()).toEqual(
      Object.keys(server.emptyTerritoryFigures()).sort(),
    );
    const ranked = [
      { code: "N", figures: north },
      { code: "S", figures: south },
      { code: "E", figures: emptyTerritoryFigures() },
    ];
    for (const key of [
      "sales",
      "attainment",
      "coverage",
      "strikeRate",
      "distributionGaps",
    ] as const)
      expect(rankTerritories(ranked, key).map((r) => r.code)).toEqual(
        server.rankTerritories(ranked, key).map((r) => r.code),
      );
  });

  it("sums territories before dividing", () => {
    const total = combineTerritoryFigures([north, south]);
    // 147 of 170 calls, not the mean of 90% and 80%.
    expect(territoryRates(total).strikeRatePct).toBe(86);
    expect(territoryRates(total).attainmentPct).toBe(88);
    expect(belowTarget(north)).toBe(true);
    expect(belowTarget(south)).toBe(false);
    expect(belowTarget(figures({ sales: 5 }))).toBe(false);
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
    expect(pesoText(123_456)).toContain("1,235");
  });
});

const list = {
  truncated: false,
  channels: ["GT"],
  units: [{ id: "u1", code: "A", name: "Region A" }],
  territories: [
    {
      territoryId: "t1",
      code: "T-N",
      name: "North",
      channel: "GT",
      ownerUnitName: "Region A",
    },
    {
      territoryId: "t2",
      code: "T-S",
      name: "South",
      channel: "GT",
      ownerUnitName: "Region A",
    },
    {
      territoryId: "t3",
      code: "T-W",
      name: "West",
      channel: null,
      ownerUnitName: "Region A",
    },
  ],
};
const result = (id: string, f: TerritoryFigures, gaps = 0) => ({
  territoryId: id,
  code: id,
  name: id,
  from: "2026-09-23",
  to: "2026-09-29",
  sourceRef: "test",
  figures: f,
  gapOutlets: Array.from({ length: gaps }, (_, i) => ({
    outletId: `o${i}`,
    code: `O${i}`,
    name: `Store ${i}`,
  })),
});

function render(
  over: Partial<Parameters<typeof TerritoryPerformanceView>[0]> = {},
) {
  const results = new Map([
    ["t1", result("t1", north, 2)],
    ["t2", result("t2", south)],
  ]);
  return renderToStaticMarkup(
    <TerritoryPerformanceView
      // Test doubles: ids are plain strings here.
      list={list as never}
      results={results as never}
      period={{ from: "2026-09-23", to: "2026-09-29" }}
      preset="7"
      onPreset={() => {}}
      sort="sales"
      onSort={() => {}}
      belowTargetOnly={false}
      onBelowTargetOnly={() => {}}
      orgUnitId=""
      onOrgUnit={() => {}}
      channel=""
      onChannel={() => {}}
      {...over}
    />,
  );
}

describe("TerritoryPerformanceView", () => {
  it("ranks loaded territories with totals, flags and gap stores", () => {
    const html = render();
    expect(html).toContain("Territory performance");
    expect(html).toContain("Loading 1…");
    expect(html.indexOf("North")).toBeLessThan(html.indexOf("South"));
    expect(html).toContain("Below target");
    expect(html).toContain("4 missed");
    expect(html).toContain("147 of 170 calls productive");
    expect(html).toContain("49 of 60 stores buying");
    expect(html).toContain("O0 Store 0, O1 Store 1 and 8 more");
    expect(html).toContain("Region A");
    expect(html).toContain("provisional");
  });

  it("ranks by attainment and filters below target", () => {
    const ranked = render({ sort: "attainment" });
    expect(ranked.indexOf("South")).toBeLessThan(ranked.indexOf("North"));
    const below = render({ belowTargetOnly: true });
    expect(below).toContain("North");
    expect(below).not.toContain(">South<");
  });

  it("stays hidden without the reading capabilities", () => {
    permissions = { capabilities: ["report.read"] };
    expect(renderToStaticMarkup(<TerritoryPerformance />)).toBe("");
    permissions = undefined;
    expect(renderToStaticMarkup(<TerritoryPerformance />)).toBe("");
  });
});
