import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import {
  NegativeStockPanel,
  negativeStockErrorMessage,
} from "./negative-stock-panel";

const data = vi.hoisted(() => ({
  empty: false,
  national: true,
  flagStatus: "Exhausted" as string,
  allowanceArgs: [] as unknown[],
  paginatedArgs: [] as unknown[],
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "inventory/negative_stock:allowances")
      data.allowanceArgs.push(args);
    if (name === "inventory/negative_stock:canManageAllowances")
      return data.national;
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
    return undefined;
  },
  usePaginatedQuery: (ref: unknown, args: unknown, options: unknown) => {
    data.paginatedArgs.push({
      name: getFunctionName(ref as never),
      args,
      options,
    });
    return {
      status: data.flagStatus,
      loadMore: vi.fn(),
      isLoading: false,
      results: data.empty
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
          ],
    };
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

  it("shows allowances read-only to anyone who is not a national administrator", () => {
    data.national = false;
    const html = renderToStaticMarkup(
      createElement(NegativeStockPanel, { locations }),
    );
    expect(html).toContain("<span>Can sell below zero</span>");
    expect(html).toContain("<span>Stops at zero</span>");
    expect(html).not.toContain("<button>Stop</button>");
    expect(html).not.toContain("<button>Allow</button>");
    // Settling stays available; the server checks approval per location.
    expect(html).toContain("<button>Settle</button>");
    data.national = true;
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

  it("asks only for the shown locations' allowances and pages flags instead of capping them", () => {
    data.allowanceArgs = [];
    data.paginatedArgs = [];
    renderToStaticMarkup(createElement(NegativeStockPanel, { locations }));
    expect(data.allowanceArgs).toContainEqual({ locationIds: ["truck", "wh"] });
    expect(data.paginatedArgs).toContainEqual({
      name: "inventory/negative_stock:flags",
      args: { status: "open" },
      options: { initialNumItems: 25 },
    });
    data.allowanceArgs = [];
    renderToStaticMarkup(
      createElement(NegativeStockPanel, { locations: undefined }),
    );
    expect(data.allowanceArgs).toContainEqual("skip");
  });

  it("never says nothing is below zero while older flags are unchecked", () => {
    data.empty = true;
    data.flagStatus = "CanLoadMore";
    const html = renderToStaticMarkup(
      createElement(NegativeStockPanel, { locations }),
    );
    expect(html).not.toContain("Nothing below zero");
    expect(html).toContain("older ones not checked yet");
    expect(html).toContain("<button>Show older</button>");
    data.flagStatus = "Exhausted";
    data.empty = false;
  });

  it("says when more locations exist than it shows", () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      _id: `t${index}`,
      code: `TRUCK-${index}`,
      name: `Truck ${index}`,
      type: "truck",
    }));
    const html = renderToStaticMarkup(
      createElement(NegativeStockPanel, { locations: many }),
    );
    expect(html).toContain("Showing the first 200 of 201 locations");
    expect(html).not.toContain("TRUCK-200<");
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
