import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import {
  NegativeStockPanel,
  negativeStockErrorMessage,
} from "./negative-stock-panel";

const data = vi.hoisted(() => ({ empty: false }));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "inventory/negative_stock:allowances")
      return data.empty
        ? []
        : [
            {
              id: "a1",
              locationId: "truck",
              locationCode: "TRUCK-001",
              locationName: "Truck one",
              operation: "distributor",
              movementTypes: ["pos_sale"],
              limitBase: null,
              active: true,
              sourceRef: "CALL-10",
              version: 1,
              updatedAt: 1,
            },
          ];
    if (name === "inventory/negative_stock:flags")
      return data.empty
        ? []
        : [
            {
              id: "f1",
              movementNumber: "MV-1",
              movementType: "pos_sale",
              productCode: "P1",
              locationCode: "TRUCK-001",
              shortfall: "5",
              currentAvailable: "-5",
              status: "open",
            },
            {
              id: "f2",
              movementNumber: "MV-2",
              movementType: "pos_sale",
              productCode: "P2",
              locationCode: "TRUCK-001",
              shortfall: "1",
              currentAvailable: "3",
              status: "open",
            },
          ];
    return undefined;
  },
  useMutation: () => vi.fn(),
}));
vi.mock("@heroui/react", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
  Button: ({ children }: { children: React.ReactNode }) =>
    createElement("button", null, children),
}));
vi.mock("@sunpride/ui", () => ({
  Card: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement("section", { "data-label": label }, children),
  Notice: ({ title }: { title: string }) => createElement("aside", null, title),
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  WorkspaceIcon: () => null,
}));

const locations = [
  { _id: "truck", code: "TRUCK-001", name: "Truck one", type: "truck" },
  { _id: "wh", code: "WH-MNL", name: "Manila", type: "warehouse" },
  { _id: "transit", code: "TRANSIT", name: "In transit", type: "in_transit" },
  { _id: "returns", code: "RET", name: "Pull-outs", type: "returns" },
];

describe("NegativeStockPanel (SP-0085)", () => {
  it("lists below-zero sales to settle and which stock locations may sell below zero", () => {
    data.empty = false;
    const html = renderToStaticMarkup(
      createElement(NegativeStockPanel, { locations }),
    );
    expect(html).toContain('data-label="Below-zero stock"');
    expect(html).toContain("P1 · TRUCK-001");
    expect(html).toContain("MV-1 · short 5 · now -5");
    expect(html).toContain("<span>Below zero</span>");
    expect(html).toContain("<span>Covered</span>");
    expect(html).toContain("<span>Can sell below zero</span>");
    expect(html).toContain("<button>Stop</button>");
    expect(html).toContain("WH-MNL");
    expect(html).toContain("<span>Stops at zero</span>");
    expect(html).toContain("<button>Allow</button>");
    // Pull-outs (returns) and bookkeeping locations are never offered.
    expect(html).not.toContain("TRANSIT");
    expect(html).not.toContain("RET<");
  });

  it("shows calm empty states", () => {
    data.empty = true;
    const html = renderToStaticMarkup(
      createElement(NegativeStockPanel, { locations: [] }),
    );
    expect(html).toContain("Nothing below zero");
    expect(html).toContain("No stock locations");
    data.empty = false;
  });

  it("surfaces the server's plain refusal text and hides anything else", () => {
    expect(
      negativeStockErrorMessage({
        data: "Stock is still below zero; receive or count it before resolving",
      }),
    ).toBe("Stock is still below zero; receive or count it before resolving");
    expect(negativeStockErrorMessage(new Error("boom"))).toBe(
      "Action failed. Try again.",
    );
  });
});
