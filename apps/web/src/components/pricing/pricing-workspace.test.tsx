import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsePriceRows, PricingWorkspace } from "./pricing-workspace";
const state = vi.hoisted(() => ({
  canEdit: true,
  values: {} as Record<string, unknown>,
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[]) => ({
    data: key ? state.values[String(key[1])] : undefined,
  }),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
  useLive: vi.fn(),
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({
    can: (c: string) => c !== "masterdata.manage" || state.canEdit,
  }),
}));
beforeEach(() => {
  state.canEdit = true;
  state.values = {
    lists: {
      rows: [
        {
          id: "raw-list",
          code: "GT",
          name: "General trade",
          channelKey: "gt",
          source: "sample",
          status: "active",
          effectiveFrom: 1792368000000,
          effectiveTo: null,
          lineCount: 1,
        },
      ],
    },
    promotions: {
      rows: [
        {
          id: "raw-promo",
          code: "OCT",
          name: "October discount",
          rule: { kind: "percent_off" },
          status: "active",
          source: "office",
        },
      ],
    },
    matrix: {
      channels: ["gt"],
      rows: [
        {
          productId: "raw-product",
          productCode: "FOOD",
          productName: "Canned food",
          uom: "PC",
          prices: [
            { channel: "gt", unitPriceCentavos: null, source: "missing" },
          ],
        },
      ],
      next: null,
      asOf: 1792368000000,
    },
  };
});
describe("channel pricing workspace", () => {
  it("shows channel lists, missing-price warning, product matrix, sample provenance and next actions", () => {
    const h = renderToStaticMarkup(createElement(PricingWorkspace));
    for (const s of [
      "1 products need a channel price",
      "General trade",
      "Sample data",
      "Product × channel matrix",
      "Canned food",
      "Needs price",
      "October discount",
      "Create a channel price list",
      "Create a promotion",
    ])
      expect(h).toContain(s);
    expect(h).not.toContain("raw-promo</");
    expect(h).not.toContain("raw-product</");
  });
  it("hides pricing write actions for a reader", () => {
    state.canEdit = false;
    const h = renderToStaticMarkup(createElement(PricingWorkspace));
    expect(h).not.toContain("Create a promotion");
    expect(h).not.toContain("Create a channel price list");
    expect(h).not.toContain("Deactivate");
  });
  it("parses integer centavos including a known zero", () => {
    expect(parsePriceRows("FOOD,PC,1250\nFREE,PC,0")).toEqual([
      { productCode: "FOOD", uom: "PC", unitPriceCentavos: 1250 },
      { productCode: "FREE", uom: "PC", unitPriceCentavos: 0 },
    ]);
  });
  it("refuses fractional prices and incomplete imports before sending", () => {
    expect(() => parsePriceRows("FOOD,PC,12.50")).toThrow("Row 1");
    expect(() => parsePriceRows("FOOD,,1250")).toThrow("Row 1");
    expect(() => parsePriceRows("")).toThrow();
  });
  it("does not call an unconfigured channel catalog ready", () => {
    state.values.matrix = { channels: [], rows: [], next: null };
    expect(renderToStaticMarkup(createElement(PricingWorkspace))).toContain(
      "Channel pricing needs setup",
    );
  });
});
