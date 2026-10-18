import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/errors";
import {
  NegativeStockPanel,
  negativeStockErrorMessage,
} from "./negative-stock-panel";
const data = vi.hoisted(() => ({
  empty: false,
  national: true,
  status: "exhausted",
  keys: [] as unknown[],
  reads: [] as unknown[],
  requests: [] as unknown[],
  canResolve: true,
}));
vi.mock("../lib/api", async () => {
  const { ApiError } =
    await vi.importActual<typeof import("../lib/api/errors")>(
      "../lib/api/errors",
    );
  const q = (base: number) => ({
    base,
    cases: 0,
    pieces: base,
    display: `${base} pc`,
    valueCentavos: Math.abs(base) * 100,
  });
  return {
    ApiError,
    apiFetch: (...args: unknown[]) => {
      data.requests.push(args);
      return Promise.resolve({});
    },
    useLive: vi.fn(),
    useMutate: () => ({ pending: false, mutate: vi.fn() }),
    useApi: (key: unknown, fetcher: unknown) => {
      data.keys.push(key);
      data.reads.push(fetcher);
      return {
        data: {
          canManage: data.national,
          allowances: data.empty
            ? []
            : [
                {
                  id: "a1",
                  locationId: "truck",
                  active: true,
                  movementTypes: ["pos_sale"],
                  sourceRef: "CALL-10",
                  limitBase: null,
                },
              ],
        },
      };
    },
    useApiPages: () => ({
      status: data.status,
      isComplete: data.status === "exhausted",
      loadMore: vi.fn(),
      items: data.empty
        ? []
        : [
            {
              id: "f1",
              number: "MV-1",
              name: "Corned beef",
              code: "P1",
              locationName: "Truck one",
              shortfall: q(5),
              current: q(-5),
              canResolve: data.canResolve,
            },
            {
              id: "f2",
              number: "MV-2",
              name: "Beef loaf",
              code: "P2",
              locationName: "Truck one",
              shortfall: q(1),
              current: q(3),
              canResolve: data.canResolve,
            },
          ],
    }),
  };
});
vi.mock("@heroui/react", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
  Button: ({
    children,
    isDisabled,
  }: {
    children: React.ReactNode;
    isDisabled?: boolean;
  }) => createElement("button", { disabled: isDisabled }, children),
}));
vi.mock("@sunpride/ui", () => ({
  Card: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement("section", { "data-label": label }, children),
  Notice: ({ title }: { title: string }) => createElement("aside", null, title),
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
}));
const locations = [
  { _id: "truck", code: "TRUCK-001", name: "Truck one", type: "truck" },
  { _id: "wh", code: "WH-MNL", name: "Manila", type: "warehouse" },
  { _id: "transit", code: "TRANSIT", name: "In transit", type: "in_transit" },
  { _id: "returns", code: "RET", name: "Pull-outs", type: "returns" },
];
beforeEach(() =>
  Object.assign(data, {
    empty: false,
    national: true,
    status: "exhausted",
    keys: [],
    reads: [],
    requests: [],
    canResolve: true,
  }),
);
const render = (ls: typeof locations | undefined = locations) =>
  renderToStaticMarkup(createElement(NegativeStockPanel, { locations: ls }));
describe("Below-zero stock on the v2 API", () => {
  it("lists below-zero sales in explicit units and pesos and only eligible stock locations", () => {
    const html = render();
    expect(html).toContain('data-label="Below-zero stock"');
    expect(html).toContain("Corned beef · Truck one");
    expect(html).toContain("MV-1 · short 5 pc · now -5 pc");
    expect(html).toContain("₱5.00");
    expect(html).toContain("<span>Below zero</span>");
    expect(html).toContain("<span>Covered</span>");
    expect(html).toContain("<span>Can sell below zero</span>");
    expect(html).toContain("Stop</button>");
    expect(html).toContain("Allow</button>");
    expect(html).not.toContain("TRANSIT");
    expect(html).not.toContain("RET<");
  });
  it("shows allowances read-only outside national administration, while authorized settlement remains", () => {
    data.national = false;
    const html = render();
    expect(html).toContain("Can sell below zero");
    expect(html).not.toContain("Stop</button>");
    expect(html).not.toContain("Allow</button>");
    expect(html).toContain("Settle</button>");
  });
  it("shows calm empty states only when pages are complete", () => {
    data.empty = true;
    const html = render([]);
    expect(html).toContain("Nothing below zero");
    expect(html).toContain("No stock locations");
  });
  it("keys allowances by shown locations, skips when unavailable, and pages instead of a silent flag cap", () => {
    render();
    expect(data.keys).toContainEqual([
      "inventory",
      "negative",
      "allowances",
      ["truck", "wh"],
    ]);
    const fetcher = data.reads[0] as (c: {
      signal: AbortSignal;
    }) => Promise<unknown>;
    void fetcher({ signal: new AbortController().signal });
    expect(data.requests[0]).toMatchObject([
      "/api/v1/inventory/negative",
      { query: { locationIds: "truck,wh" } },
    ]);
    renderToStaticMarkup(
      createElement(NegativeStockPanel, { locations: undefined }),
    );
    expect(data.keys).toContain(null);
  });
  it("never says nothing below zero while older flags are unchecked", () => {
    data.empty = true;
    data.status = "canLoadMore";
    const html = render();
    expect(html).not.toContain("Nothing below zero");
    expect(html).toContain("older ones not checked yet");
    expect(html).toContain("Show older</button>");
  });
  it("discloses when the displayed allowance locations are incomplete", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      _id: `t${i}`,
      code: `TRUCK-${i}`,
      name: `Truck ${i}`,
      type: "truck",
    }));
    const html = render(many);
    expect(html).toContain("Showing the first 200 of 201 locations");
    expect(html).not.toContain("TRUCK-200<");
  });
  it("surfaces only the typed API refusal text, not opaque errors", () => {
    expect(
      negativeStockErrorMessage(
        new ApiError({
          code: "still_negative",
          message:
            "Stock is still below zero; receive or count it before resolving",
          status: 422,
        }),
      ),
    ).toBe("Stock is still below zero; receive or count it before resolving");
    expect(negativeStockErrorMessage(new Error("private backend detail"))).toBe(
      "Action failed. Try again.",
    );
  });
  it("does not offer settlement to the original poster or an unauthorized role", () => {
    data.canResolve = false;
    const html = render();
    expect(html).not.toContain("Settle</button>");
    expect(html).toContain("A different authorized person must settle");
  });
});
