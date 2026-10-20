import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  usePathname: () => "/coverage-people",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
import { AvailabilityCoverage } from "./coverage";
import type { RetailAvailability } from "./types";
import { StockView } from "../cockpit/pages/stock";
import { analyticsFixture, fixtureNow } from "../cockpit/fixtures";
const empty: RetailAvailability = {
  universe: null,
  required: 0,
  checked: 0,
  present: 0,
  completeness: null,
  rows: [],
  depths: [],
  trend: [],
};
const render = (data: RetailAvailability) =>
  renderToStaticMarkup(<AvailabilityCoverage data={data} />);
describe("F-214 F-215 F-220 availability inside the existing Coverage cockpit", () => {
  it("F-214 keeps historical buying reach distinct from stocking distribution on Products & stock", () => {
    const data = analyticsFixture(
      "stock",
      { from: "2026-10-01", to: "2026-10-20" },
      fixtureNow(Date.parse("2026-10-20T12:00:00+08:00")),
    );
    const html = renderToStaticMarkup(<StockView data={data} csv="" />);
    expect(html).toContain("Buying reach");
    expect(html).not.toContain("Stores carrying");
  });
  it("keeps a missing validated denominator unknown and offers a setup action", () => {
    const html = render(empty);
    expect(html).toContain("Distribution is unknown, not zero");
    expect(html).toContain("/admin?section=availability");
    expect(html.split("</section>")[0]).not.toContain("0.0%");
  });
  it("labels sample and stale universes and never hides missing stocking evidence", () => {
    const data: RetailAvailability = {
      ...empty,
      universe: {
        id: "universe",
        label: "SAMPLE census",
        date: "2026-09-01",
        sourceRef: "SAMPLE",
        sample: true,
        fresh: false,
        members: 2,
      },
      required: 4,
      checked: 3,
      present: 2,
      completeness: 75,
      rows: [
        {
          productId: "sku",
          code: "SKU",
          name: "Corned beef",
          universe: 2,
          stocking: 1,
          absent: 0,
          unknown: 1,
          ndPct: null,
          wdPct: null,
          ndLowerPct: 50,
          wdLowerPct: 25,
          weightsKnown: true,
          gaps: [{ outletId: "store", name: "Store A", state: "unknown" }],
        },
      ],
      depths: [
        {
          outletId: "store",
          name: "Store A",
          stockedSkus: 1,
          unknownSkus: 1,
          boughtSkus: 0,
          planned: 2,
          actual: 1,
        },
      ],
      trend: [{ date: "2026-10-20", osa: 50, completeness: 75 }],
    };
    const html = render(data);
    expect(html).toContain("Sample data");
    expect(html).toContain("Stale universe");
    expect(html).toContain("3 of 4");
    expect(html).toContain("75.0%");
    expect(html).toContain("Corned beef");
    expect(html).toContain("1 / 2");
    expect(html).toContain("Calls / plan");
    expect(html).toContain("/stores/store?storeId=store");
    expect(html).not.toContain("outletId");
    expect(html).not.toContain("Something went wrong");
  });
});
