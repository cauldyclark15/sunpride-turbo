import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { InventoryWorkspace } from "./inventory-workspace";

const data = vi.hoisted(() => ({ ready: true }));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "domains/masterData:products")
      return data.ready
        ? [
            {
              _id: "p",
              code: "P1",
              name: "Product one",
              baseUomId: "u",
              quantityScale: 1000,
              trackingMode: "none",
              allocationPolicy: "none",
            },
          ]
        : [];
    if (name === "inventory/queries:locations")
      return data.ready
        ? [{ _id: "l", code: "L1", name: "Main", type: "warehouse" }]
        : [];
    if (name === "inventory/queries:overview")
      return data.ready
        ? [
            {
              id: "b",
              productCode: "P1",
              productName: "Product one",
              locationCode: "L1",
              locationType: "warehouse",
              physical: 240,
              available: 230,
              reserved: 10,
              qualityHold: 0,
              version: 1,
            },
          ]
        : [];
    return [];
  },
  usePaginatedQuery: () => ({ results: [], status: "Exhausted" }),
  useMutation: () => vi.fn(),
}));
vi.mock("@heroui/react", () => {
  const Select = Object.assign(
    ({ children }: { children: React.ReactNode }) =>
      createElement("div", null, children),
    {
      Trigger: ({ children }: { children: React.ReactNode }) =>
        createElement("button", null, children),
      Value: () => createElement("span", null, "All locations"),
      Indicator: () => null,
      Popover: ({ children }: { children: React.ReactNode }) =>
        createElement("div", null, children),
    },
  );
  const ListBox = Object.assign(
    ({ children }: { children: React.ReactNode }) =>
      createElement("div", null, children),
    {
      Item: ({ children }: { children: React.ReactNode }) =>
        createElement("div", null, children),
    },
  );
  return {
    Select,
    ListBox,
    Input: (props: Record<string, unknown>) => createElement("input", props),
    Button: ({ children }: { children: React.ReactNode }) =>
      createElement("button", null, children),
  };
});
vi.mock("@sunpride/ui", () => ({
  PageHeader: ({ title, meta }: { title: string; meta: string }) =>
    createElement(
      "header",
      null,
      createElement("h1", null, title),
      createElement("p", null, meta),
    ),
  Card: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement("section", { "data-label": label }, children),
  MetricCard: ({
    label,
    value,
    detail,
  }: {
    label: string;
    value: string;
    detail?: string;
  }) => createElement("article", null, label, " ", value, detail),
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
  WorkspaceToolbar: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  WorkspaceIcon: () => null,
  ListRow: () => null,
}));

describe("Inventory calm stock view", () => {
  it("shows live stat, undecorated KPIs and a two-line, right-aligned table without a healthy banner", () => {
    data.ready = true;
    const html = renderToStaticMarkup(
      createElement(InventoryWorkspace, { setupMessage: "Connected" }),
    );
    expect(html).toContain("<h1>Inventory</h1>");
    expect(html).toContain("240 cases · 1 location");
    expect(html).toContain("Stock · cases");
    expect(html).toContain("Physical 240");
    expect(html).toContain('data-label="Stock by location"');
    expect(html).toContain('class="text-right tabular-nums">240');
    expect(html).toContain(
      'Product one</span><span class="block font-mono text-xs text-muted">P1',
    );
    expect(html).not.toContain("Inventory is ready");
    expect(html).not.toContain("base cases across filtered locations");
    expect(html).not.toContain("<aside>");
  });
  it("offers setup only when stock is not configured", () => {
    data.ready = false;
    const html = renderToStaticMarkup(
      createElement(InventoryWorkspace, { setupMessage: "Connected" }),
    );
    expect(html).toContain(
      "<aside>Set up inventory to continue<button>Set up</button></aside>",
    );
  });
});
