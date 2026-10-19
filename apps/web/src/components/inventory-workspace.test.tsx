import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InventoryWorkspace,
  enteredStockQuantity,
  stockMoney,
} from "./inventory-workspace";

const state = vi.hoisted(() => ({
  ready: true,
  empty: false,
  unknown: false,
  error: false,
  tab: "stock",
  stateIndex: 0,
  canWrite: true,
  readKeys: [] as unknown[],
  writes: [] as unknown[],
  buttons: [] as { label: string; press?: () => void }[],
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      state.stateIndex++;
      const value =
        state.stateIndex === 1
          ? state.tab
          : state.tab === "receiving"
            ? (({ 3: "p", 6: "3", 7: "6", 9: "l" } as Record<number, unknown>)[
                state.stateIndex
              ] ?? initial)
            : initial;
      return actual.useState(value);
    },
  };
});
const q = {
  base: 1920,
  cases: 40,
  pieces: 0,
  display: "40 cs",
  valueCentavos: 2400000,
};
const stock = {
  productId: "p",
  code: "P1",
  name: "Corned beef",
  locationId: "l",
  locationName: "Main depot",
  locationType: "warehouse",
  kind: "depot",
  onHand: q,
  available: q,
  reserved: { ...q, base: 0, display: "0 pc" },
  hold: { ...q, base: 0, display: "0 pc" },
  valueCentavos: 2400000,
  prior: { ...q, display: "38 cs" },
  daysCover: null,
  target: { ...q, display: "50 cs" },
  status: "low",
  units: { basePerCase: 48, basePerPiece: 1, baseCode: "PC", scale: 1 },
};
vi.mock("../lib/api", () => ({
  apiFetch: vi.fn(),
  useLive: vi.fn(),
  useApi: (key: unknown) => {
    state.readKeys.push(key);
    const k = key as string[] | null;
    const common = { status: "success", error: undefined };
    if (k?.[1] === "products")
      return {
        ...common,
        data: state.ready
          ? [
              {
                id: "p",
                code: "P1",
                name: "Corned beef",
                tracking: "none",
                units: stock.units,
              },
            ]
          : [],
      };
    if (k?.[1] === "locations")
      return {
        ...common,
        data: state.ready
          ? [
              {
                id: "l",
                _id: "l",
                code: "L1",
                name: "Main depot",
                type: "warehouse",
                active: true,
              },
            ]
          : [],
      };
    if (k?.[1] === "overview")
      return {
        status: state.error ? "error" : "success",
        error: state.error
          ? { message: "Stock is unavailable. Retry." }
          : undefined,
        data: state.error
          ? undefined
          : {
              asOf: 1792368000000,
              valuation: "Default price",
              locations: [
                {
                  id: "l",
                  name: "Main depot",
                  type: "warehouse",
                  kind: "depot",
                  valueCentavos: state.unknown ? null : 2400000,
                  priorValueCentavos: 2200000,
                  out: 0,
                  low: 1,
                },
              ],
              rows: state.empty
                ? []
                : [
                    {
                      ...stock,
                      valueCentavos: state.unknown ? null : stock.valueCentavos,
                      onHand: state.unknown ? { ...q, valueCentavos: null } : q,
                    },
                  ],
              out: [],
              low: state.empty ? [] : [stock],
              nearExpiry: [],
              trend: [
                { date: "2026-10-18", valueCentavos: 2200000 },
                { date: "2026-10-19", valueCentavos: 2400000 },
              ],
              summary: {
                valueCentavos: state.unknown ? null : state.empty ? 0 : 2400000,
                priorValueCentavos: 2200000,
                outAtDepot: 0,
                low: state.empty ? 0 : 1,
                nearExpiry: 0,
                unknownPrices: state.unknown ? 1 : 0,
                policiesMissing: state.unknown ? 1 : 0,
              },
            },
      };
    return { ...common, data: undefined };
  },
  useApiPages: () => ({
    items: [],
    status: "exhausted",
    isComplete: true,
    loadMore: vi.fn(),
  }),
  useMutate: () => ({
    pending: false,
    mutate: async (...args: unknown[]) => {
      state.writes.push(args);
      return { id: "saved" };
    },
  }),
}));
vi.mock("../lib/auth", () => ({
  usePermissions: () => ({ can: () => state.canWrite }),
}));
vi.mock("./negative-stock-panel", () => ({
  NegativeStockPanel: () => createElement("aside", null, "Below-zero stock"),
}));
vi.mock("@heroui/react", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
  }) => {
    state.buttons.push({ label: String(children), press: onPress });
    return createElement("button", { disabled: isDisabled }, children);
  },
}));
vi.mock("@sunpride/ui", () => ({
  PageHeader: ({ title, meta }: { title: string; meta: string }) =>
    createElement("header", null, createElement("h1", null, title), meta),
  FormField: ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => createElement("label", null, label, children),
  Card: ({
    label,
    children,
    actions,
  }: {
    label: string;
    children: React.ReactNode;
    actions?: React.ReactNode;
  }) => createElement("section", { "data-label": label }, actions, children),
  MetricCard: ({
    label,
    value,
    detail,
  }: {
    label: string;
    value: string;
    detail?: string;
  }) => createElement("article", null, label, " ", value, " ", detail),
  Notice: ({ title, meta }: { title: string; meta?: React.ReactNode }) =>
    createElement("aside", null, title, meta),
  UnderlineTabs: ({
    items,
  }: {
    items: readonly (readonly [string, string])[];
  }) =>
    createElement(
      "nav",
      null,
      ...items.map(([id, label]) =>
        createElement("button", { key: id }, label),
      ),
    ),
}));
function render() {
  state.stateIndex = 0;
  return renderToStaticMarkup(
    createElement(InventoryWorkspace, { setupMessage: "Connected" }),
  );
}
beforeEach(() => {
  Object.assign(state, {
    ready: true,
    empty: false,
    unknown: false,
    error: false,
    tab: "stock",
    stateIndex: 0,
    canWrite: true,
    readKeys: [],
    writes: [],
    buttons: [],
  });
});

describe("Inventory owner overview on the v2 API", () => {
  it("shows real case units, location values, targets, prior period, trend, drills and actions without a healthy banner", () => {
    const html = render();
    expect(html).toContain("<h1>Inventory</h1>");
    expect(html).toContain("Is the right stock in the right place?");
    expect(html).toContain("40 cs");
    expect(html).not.toContain("1,920 cases");
    expect(html).toContain("Main depot");
    expect(html).toContain("₱24,000.00");
    expect(html).toContain("Target 50 cs");
    expect(html).toContain("28 days ago 38 cs");
    expect(html).toContain("Stock value over the last 14 days");
    expect(html).toContain("Transfer</button>");
    expect(html).toContain("Count</button>");
    expect(html).toContain("Adjust</button>");
    expect(html).toContain("Export CSV");
    expect(html).not.toContain("Inventory is ready");
  });
  it("keeps configured location count distinct from empty stock", () => {
    state.empty = true;
    const html = render();
    expect(html).toContain("Locations configured 1");
    expect(html).toContain("No stock yet");
    expect(html).toContain("₱0.00");
  });
  it("offers a setup destination only when inventory is not configured", () => {
    state.ready = false;
    const html = render();
    expect(html).toContain(
      "Inventory is not set up yet. Ask your administrator.",
    );
    expect(html).toContain('href="/admin"');
    expect(html).toContain("Set up locations and catalog");
    state.ready = true;
    expect(render()).not.toContain("Set up locations and catalog");
  });
  it("keeps production and SAP hidden while retaining receiving, transfers and blind counts", () => {
    const html = render();
    expect(html).not.toContain("Production</button>");
    expect(html).not.toContain("SAP");
    expect(html).toContain("Receiving</button>");
    expect(html).toContain("Transfers</button>");
    expect(html).toContain("Stock counts</button>");
  });
  it("does not turn unknown price, demand or missing target into zero", () => {
    state.unknown = true;
    const html = render();
    expect(html).toContain("Stock selling value Unknown");
    expect(html).toContain("Unknown demand");
    expect(html).toContain("targets need setup");
  });
  it("shows API failure instead of a misleading empty or healthy stock view", () => {
    state.error = true;
    const html = render();
    expect(html).toContain("Stock is unavailable. Retry.");
    expect(html).not.toContain("No stock yet");
    expect(html).not.toContain("Out at depot");
  });
  it("sends the catalog-derived base quantity, not a fixed thousand, and supplies an idempotent intent key", async () => {
    state.tab = "receiving";
    render();
    const button = state.buttons.find((b) => b.label === "Post receipt");
    expect(button).toBeDefined();
    button?.press?.();
    await Promise.resolve();
    expect(state.writes[0]).toMatchObject([
      "/api/v1/inventory/receipts/post",
      {
        idempotencyKey: expect.any(String),
        receivingLocationId: "l",
        lines: [{ productId: "p", quantityBase: 150 }],
      },
      { invalidate: [["inventory"]] },
    ]);
  });
  it("makes a read-only role's stock drill available without write actions", () => {
    state.canWrite = false;
    const html = render();
    expect(html).toContain("Corned beef");
    expect(html).not.toContain("Transfer</button>");
    expect(html).not.toContain("Adjust</button>");
  });
});
describe("stock entry units", () => {
  it("converts 40 cases to 1920 pieces and mixed units exactly", () => {
    expect(enteredStockQuantity("40", "", stock.units)).toBe(1920);
    expect(enteredStockQuantity("3", "6", stock.units)).toBe(150);
    expect(enteredStockQuantity("0", "0", stock.units, true)).toBe(0);
  });
  it("rejects missing conversion, invalid, negative and fractional base entries", () => {
    expect(() =>
      enteredStockQuantity("1", "", { ...stock.units, basePerCase: null }),
    ).toThrow("conversion");
    expect(() => enteredStockQuantity("-1", "0", stock.units)).toThrow();
    expect(() => enteredStockQuantity("0", "0.1", stock.units)).toThrow();
    expect(stockMoney(null)).toBe("Unknown");
  });
});
