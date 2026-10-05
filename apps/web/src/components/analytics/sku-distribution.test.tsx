import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as server from "../../../../../packages/backend/convex/analytics/sku_model";
import {
  channelSplit,
  combineSkuFigures,
  emptySkuFigures,
  matchesSku,
  rankSkus,
  ratePct,
  skuRates,
  skuRows,
  territorySplit,
  type SkuFigures,
  type TerritorySkus,
} from "../../lib/sku-distribution";

let permissions: { capabilities: string[] } | undefined;
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => permissions,
}));

import { SkuDistribution, SkuDistributionView } from "./sku-distribution";

const figures = (over: Partial<SkuFigures>): SkuFigures => ({
  ...emptySkuFigures(),
  ...over,
});

const north: TerritorySkus = {
  territoryId: "t1",
  code: "T-N",
  name: "North",
  channel: "GT",
  activeOutlets: 10,
  auditedOutlets: 4,
  skus: [
    {
      productCode: "P1",
      name: "Corned beef",
      category: "Canned",
      figures: figures({
        buyingOutlets: 8,
        orders: 9,
        quantity: 40,
        salesMinor: 500_000,
        returnsMinor: 20_000,
        auditedOutlets: 4,
        onShelfOutlets: 3,
        outOfStockOutlets: 1,
      }),
    },
    {
      productCode: "P2",
      name: "Luncheon meat",
      category: "Canned",
      figures: figures({ buyingOutlets: 2, orders: 2, salesMinor: 100_000 }),
    },
  ],
};
const south: TerritorySkus = {
  territoryId: "t2",
  code: "T-S",
  name: "South",
  channel: "MT",
  activeOutlets: 10,
  auditedOutlets: 2,
  skus: [
    {
      productCode: "P1",
      name: "Corned beef",
      category: "Canned",
      figures: figures({
        buyingOutlets: 2,
        orders: 2,
        salesMinor: 50_000,
        auditedOutlets: 2,
        onShelfOutlets: 1,
        lowStockOutlets: 1,
        outOfStockOutlets: 1,
      }),
    },
  ],
};
const west: TerritorySkus = {
  ...south,
  territoryId: "t3",
  code: "T-W",
  name: "West",
  channel: "GT",
  activeOutlets: 5,
  auditedOutlets: 0,
  skus: [],
};

describe("SKU distribution rules (web mirror)", () => {
  it("matches the server's rates and sums", () => {
    const rows = north.skus.map((sku) => sku.figures);
    expect(combineSkuFigures(rows)).toEqual(server.combineSkuFigures(rows));
    for (const row of [...rows, emptySkuFigures()])
      for (const active of [0, 7, 20])
        expect(skuRates(row, active)).toEqual(server.skuRates(row, active));
    expect(ratePct(1, 3)).toBe(server.ratePct(1, 3));
    expect(Object.keys(emptySkuFigures()).sort()).toEqual(
      Object.keys(server.emptySkuFigures()).sort(),
    );
  });

  it("sums territories per SKU before dividing", () => {
    const rows = skuRows([north, south, west]);
    const p1 = rows.find((row) => row.productCode === "P1")!;
    expect(p1.activeOutlets).toBe(25);
    expect(p1.figures.buyingOutlets).toBe(10);
    // 10 of 25 stores; 4 of 6 audited on shelf.
    expect(skuRates(p1.figures, p1.activeOutlets)).toMatchObject({
      distributionPct: 40,
      distributionGaps: 15,
      onShelfPct: 66,
      netSalesMinor: 530_000,
    });
    // P2 never sold in South or West: those stores are gaps too.
    const p2 = rows.find((row) => row.productCode === "P2")!;
    expect(skuRates(p2.figures, p2.activeOutlets).distributionGaps).toBe(23);
    expect(rankSkus(rows, "sales").map((r) => r.productCode)).toEqual([
      "P1",
      "P2",
    ]);
    expect(rankSkus(rows, "gaps").map((r) => r.productCode)).toEqual([
      "P2",
      "P1",
    ]);
    expect(rankSkus(rows, "outOfStock")[0]!.productCode).toBe("P1");
    expect(matchesSku(p2, "lunch")).toBe(true);
    expect(matchesSku(p2, "P1")).toBe(false);
  });

  it("splits one SKU by territory and by channel", () => {
    const split = territorySplit([north, south, west], "P2");
    expect(split.map((row) => [row.label, row.figures.buyingOutlets])).toEqual([
      ["North", 2],
      ["South", 0],
      ["West", 0],
    ]);
    const channels = channelSplit([north, south, west], "P1");
    expect(
      channels.map((row) => [
        row.label,
        row.detail,
        row.activeOutlets,
        row.figures.buyingOutlets,
      ]),
    ).toEqual([
      ["GT", "2 territories", 15, 8],
      ["MT", "1 territory", 10, 2],
    ]);
  });
});

const list = {
  truncated: false,
  channels: ["GT", "MT"],
  units: [{ id: "u1", code: "A", name: "Region A" }],
  territories: [north, south, west].map((t) => ({
    territoryId: t.territoryId,
    code: t.code,
    name: t.name,
    channel: t.channel,
    ownerUnitName: "Region A",
  })),
};
const result = (t: TerritorySkus) => ({
  ...t,
  from: "2026-09-23",
  to: "2026-09-29",
  sourceRef: "test",
  truncated: false,
});

function render(over: Partial<Parameters<typeof SkuDistributionView>[0]> = {}) {
  const results = new Map([
    ["t1", result(north)],
    ["t2", result(south)],
  ]);
  const gaps = new Map([
    [
      "t1",
      {
        territoryId: "t1",
        productCode: "P1",
        gapCount: 4,
        outlets: [
          {
            outletId: "o1",
            code: "O1",
            name: "Store 1",
            shelfStatus: "out_of_stock",
          },
          { outletId: "o2", code: "O2", name: "Store 2", shelfStatus: null },
        ],
      },
    ],
  ]);
  return renderToStaticMarkup(
    <SkuDistributionView
      // Test doubles: ids are plain strings here.
      list={list as never}
      results={results as never}
      gaps={gaps as never}
      period={{ from: "2026-09-23", to: "2026-09-29" }}
      preset="7"
      onPreset={() => {}}
      orgUnitId=""
      onOrgUnit={() => {}}
      channel=""
      onChannel={() => {}}
      sort="sales"
      onSort={() => {}}
      search=""
      onSearch={() => {}}
      selected=""
      onSelect={() => {}}
      {...over}
    />,
  );
}

describe("SkuDistributionView", () => {
  it("lists SKUs with buying stores, gaps, sales and shelf signals", () => {
    const html = render();
    expect(html).toContain("SKU distribution");
    expect(html).toContain("Loading 1…");
    expect(html.indexOf("Corned beef")).toBeLessThan(
      html.indexOf("Luncheon meat"),
    );
    expect(html).toContain("10 of 20 stores");
    expect(html).toContain("2 out of stock");
    expect(html).toContain("1 low stock");
    expect(html).toContain("4 of 6 audited");
    expect(html).toContain("provisional");
    expect(html).not.toContain("by territory and channel");
  });

  it("filters by search and shows the selected SKU's splits and gap stores", () => {
    const found = render({ search: "lunch" });
    expect(found).toContain("Luncheon meat");
    expect(found).not.toContain("Corned beef");
    const detail = render({ selected: "P1" });
    expect(detail).toContain("Corned beef by territory and channel");
    expect(detail).toContain("2 of 10 stores");
    expect(detail).toContain("Stores not buying P1");
    expect(detail).toContain(
      "O1 Store 1 (Out of stock), O2 Store 2 and 2 more",
    );
  });

  it("stays hidden without the reading capabilities", () => {
    permissions = { capabilities: ["report.read"] };
    expect(renderToStaticMarkup(<SkuDistribution />)).toBe("");
    permissions = undefined;
    expect(renderToStaticMarkup(<SkuDistribution />)).toBe("");
  });
});
