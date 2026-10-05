import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
}));

import {
  HISTORY_NOTE,
  LINE_STATUS,
  SellingLocationPicker,
  STOCK_SOURCE,
  SuggestedOrderPanel,
  SuggestedOrderView,
} from "./suggested-order";

type Data = Parameters<typeof SuggestedOrderView>[0]["data"];
type Line = Data["lines"][number];

const line = (over: Partial<Line> = {}): Line => ({
  productId: "p1" as Line["productId"],
  code: "P1",
  name: "Corned Beef 150g",
  unit: "CS",
  required: true,
  status: "suggest",
  suggestedQuantity: 8,
  icoQuantity: 8,
  dailyDemand: 1,
  historyQuantity: 84,
  lastPurchaseDate: "2026-09-22",
  daysSinceLastPurchase: 7,
  storeStock: 0,
  stockSource: "estimated",
  promotion: null,
  available: null,
  cappedByAvailability: false,
  reasons: ["Bought 84 CS in 84 days: 1 a day", "Suggest 8 CS"],
  ...over,
});

const data = (over: Partial<Data> = {}): Data => ({
  version: "suggested-order/v1/2026-10-05",
  sourceRef: "ANA-009",
  outlet: {
    outletId: "o1" as Data["outlet"]["outletId"],
    code: "O1",
    name: "Store O1",
  },
  customer: { code: "C1", name: "Customer C1" },
  historyStatus: "complete",
  asOfDate: "2026-09-29",
  historyFrom: "2026-07-08",
  historyDays: 84,
  nextVisit: { days: 7, source: "cycle", date: null },
  leadTimeDays: 1,
  leadTimeProvisional: true,
  coverDays: 8,
  location: null,
  lines: [
    line(),
    line({
      code: "P2",
      name: "Luncheon Meat",
      required: false,
      dailyDemand: 0.75,
      storeStock: 0.5,
      stockSource: "counted",
      suggestedQuantity: 6,
      promotion: { programRef: "PROMO-1", upliftPct: 50 },
    }),
    line({
      code: "P3",
      name: "Vienna Sausage",
      status: "no_history",
      suggestedQuantity: 0,
      reasons: [
        "No orders in the last 84 days, so no velocity to suggest from",
      ],
    }),
  ],
  totals: { skus: 3, suggestedSkus: 2, suggestedQuantity: 14, cappedSkus: 0 },
  truncated: false,
  ...over,
});

describe("suggested order view", () => {
  it("shows quantities, the cover period and each line's reasons", () => {
    const html = renderToStaticMarkup(<SuggestedOrderView data={data()} />);
    expect(html).toContain("Suggested order");
    expect(html).toContain("2 SKU(s), 14 unit(s) in total.");
    expect(html).toContain(
      "Covers 8 day(s): 7 to the visit cycle + 1 day(s) delivery lead time (provisional)",
    );
    expect(html).toContain("8 CS");
    expect(html).toContain("P1 · required");
    expect(html).toContain("+50% promo");
    expect(html).toContain("0.75");
    expect(html).toContain("Suggest 8 CS");
    expect(html).toContain(LINE_STATUS.no_history.label);
    expect(html).toContain(STOCK_SOURCE.counted);
    expect(html).toContain("Depot stock is not checked here.");
  });

  it("names the depot when availability capped the suggestion", () => {
    const html = renderToStaticMarkup(
      <SuggestedOrderView
        data={data({
          location: {
            locationId: "l1" as NonNullable<Data["location"]>["locationId"],
            code: "DEPOT-A",
            name: "Depot A",
          },
          nextVisit: { days: 4, source: "planned_stop", date: "2026-10-03" },
          leadTimeProvisional: false,
          truncated: true,
        })}
      />,
    );
    expect(html).toContain("to the next planned call (2026-10-03)");
    expect(html).not.toContain("(provisional)");
    expect(html).toContain("Limited to stock available at Depot A.");
    expect(html).toContain("too long to read in full");
  });

  it("explains an empty suggestion and shows loading", () => {
    expect(
      renderToStaticMarkup(
        <SuggestedOrderView
          data={data({
            lines: [],
            totals: {
              skus: 0,
              suggestedSkus: 0,
              suggestedQuantity: 0,
              cappedSkus: 0,
            },
          })}
        />,
      ),
    ).toContain("nothing to suggest");
    expect(
      renderToStaticMarkup(
        <SuggestedOrderPanel
          outletId={"o1" as Data["outlet"]["outletId"]}
          asOfDate="2026-09-29"
        />,
      ),
    ).toContain("Loading suggested order");
  });

  it("says when the history is limited or withheld", () => {
    expect(
      renderToStaticMarkup(<SuggestedOrderView data={data()} />),
    ).not.toContain("Only orders within your access");
    for (const status of [
      "partial_scope",
      "shared_account",
      "no_customer",
    ] as const)
      expect(
        renderToStaticMarkup(
          <SuggestedOrderView data={data({ historyStatus: status })} />,
        ),
      ).toContain(HISTORY_NOTE[status]!);
  });

  it("offers the permitted selling locations, marking the last used", () => {
    const html = renderToStaticMarkup(
      <SellingLocationPicker
        locations={[
          {
            locationId: "l1" as NonNullable<Data["location"]>["locationId"],
            code: "DEPOT-A",
            name: "Depot A",
            type: "warehouse",
            recent: true,
          },
        ]}
        value={"l1" as NonNullable<Data["location"]>["locationId"]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Sell from");
    expect(html).toContain("Depot stock not checked");
    expect(html).toContain("Depot A (DEPOT-A) · last used");
    expect(html).toMatch(/<option value="l1" selected="">/);
  });
});
