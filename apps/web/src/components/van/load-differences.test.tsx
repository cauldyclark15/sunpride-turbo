import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  LoadDifferenceRows,
  quantityText,
  reasonGiven,
  type LoadDifference,
} from "./load-differences";

vi.mock("../../lib/api", () => ({
  useApi: () => ({ data: undefined }),
  useLive: () => {},
  mutate: vi.fn(),
}));
vi.mock("../cockpit/kit", () => ({
  Panel: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./use-command", () => ({ useVanCommand: () => vi.fn() }));

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const NOW = 1_800_000_000_000;
const item: LoadDifference = {
  tripId: "t1",
  loadId: "l1",
  tripNumber: "TRIP-0042",
  serviceDate: "2026-11-06",
  truck: "Truck 1",
  sellerName: "Juan Seller",
  requestedAt: NOW - 25 * 60_000,
  ageMinutes: 25,
  differenceCentavos: "80000",
  canDecide: true,
  lines: [
    {
      lineNumber: 1,
      productCode: "SP-HAM-1K",
      productName: "Ham 1 kg",
      reason: "short_loaded",
      expected: { base: "48", cases: 4, pieces: 0 },
      counted: { base: "40", cases: 3, pieces: 4 },
      differenceBase: "-8",
      differenceCentavos: "80000",
      differs: true,
    },
    {
      lineNumber: 2,
      productCode: "SP-SAME",
      productName: "Matching product",
      reason: null,
      expected: { base: "12", cases: 1, pieces: 0 },
      counted: { base: "12", cases: 1, pieces: 0 },
      differenceBase: "0",
      differenceCentavos: "0",
      differs: false,
    },
  ],
};

describe("Decide: load differences", () => {
  it("shows van, seller, expected vs counted in cases + pieces, pesos and age", () => {
    const view = html(createElement(LoadDifferenceRows, { items: [item] }));
    expect(view).toContain("Truck 1");
    expect(view).toContain("Juan Seller");
    expect(view).toContain("Ham 1 kg");
    expect(view).toContain("Planned 4 cs");
    expect(view).toContain("Counted 3 cs 4 pc");
    expect(view).toContain("Short ₱800.00");
    expect(view).toContain("25 min ago");
    expect(view).not.toContain("Matching product");
    expect(view).not.toMatch(/centavo/i);
  });

  it("will not let anyone decide without a written reason", () => {
    const view = html(
      createElement(LoadDifferenceRows, { items: [item], onDecide: vi.fn() }),
    );
    expect(view).toContain("Reason (required)");
    const buttons = view.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toContain("disabled");
    expect(reasonGiven("")).toBe(false);
    expect(reasonGiven("   ")).toBe(false);
    expect(reasonGiven(undefined)).toBe(false);
    expect(reasonGiven("Recounted with the clerk")).toBe(true);
  });

  it("shows no buttons when this person cannot decide, and an empty state", () => {
    const view = html(
      createElement(LoadDifferenceRows, {
        items: [{ ...item, canDecide: false }],
        onDecide: vi.fn(),
      }),
    );
    expect(view).not.toContain("<button");
    expect(view).toContain("Another supervisor decides this one");
    expect(html(createElement(LoadDifferenceRows, { items: [] }))).toContain(
      "No load differences waiting",
    );
  });

  it("says plainly when the case size is not set", () => {
    expect(quantityText({ base: "40", cases: null, pieces: null })).toBe(
      "40 units (case size not set)",
    );
  });
});
