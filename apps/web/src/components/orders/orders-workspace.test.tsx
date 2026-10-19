import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  drawerKeys,
  OrderDrawer,
  OrdersWorkspace,
  savedView,
} from "./orders-workspace";
import { creditLabel, money } from "./model";
const state = vi.hoisted(() => ({
  can: true,
  values: {} as Record<string, unknown>,
  error: null as { message: string } | null,
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[]) => ({
    data: key ? state.values[String(key[1])] : undefined,
    error: state.error,
    refetch: vi.fn(),
  }),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
  useLive: vi.fn(),
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => state.can }),
}));
const order = {
  id: "raw-order-id",
  orderNumber: "SP-1234",
  status: "pending_approval",
  customerCode: "C100",
  customerName: "Market Store",
  salespersonName: "Ana Reyes",
  salespersonProfileId: "raw-person",
  channel: "gt",
  territoryName: "North Cebu",
  territoryId: "raw-territory",
  serviceDate: "2026-10-19",
  totalCentavos: null,
  creditStatus: "unknown",
  source: "Field order",
};
beforeEach(() => {
  state.can = true;
  state.error = null;
  state.values = {
    list: {
      rows: [order],
      next: null,
      period: { from: "2026-10-01", to: "2026-10-19" },
      compare: { from: "2026-09-12", to: "2026-09-30" },
      summary: {
        count: 1,
        totalCentavos: null,
        priorCentavos: 0,
        waiting: 1,
        overCredit: 0,
        unpriced: 1,
        targetCentavos: null,
      },
      trend: [{ date: "2026-10-19", orders: 1, totalCentavos: null }],
    },
    detail: {
      ...order,
      canDecide: true,
      lines: [
        {
          productCode: "P1",
          description: "Canned food",
          quantity: 2,
          quantityBase: 48,
          uom: "CS",
          unitPriceCentavos: null,
          lineTotalCentavos: null,
        },
      ],
      pricing: {
        lines: [{ productCode: "P1", source: "office" }],
        promotionsApplied: [],
      },
      credit: {
        status: "unknown",
        limit: 100000,
        exposure: null,
        definition:
          "Open captured orders only; SAP receivables are not connected.",
      },
      history: [
        {
          id: "raw-history",
          name: "Office Admin",
          to: "pending_approval",
          reason: "Buyer emailed",
          at: 1792368000000,
        },
      ],
    },
  };
});
describe("commercial control workspace", () => {
  it("shows exceptions, prior comparison, target action, trend and named drill rows", () => {
    const html = renderToStaticMarkup(createElement(OrdersWorkspace));
    for (const text of [
      "Move booked orders forward",
      "Waiting for my approval",
      "Today",
      "Over credit",
      "Rejected this week",
      "Prior period:",
      "Set target",
      "Missing prices",
      "Daily booked value",
      "Market Store",
      "Ana Reyes",
      "North Cebu",
      "Export CSV",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("raw-order-id");
    expect(html).not.toContain("raw-person");
    expect(html).not.toContain("pending_approval</td>");
  });
  it("compares booked value with the shared governed sales target", () => {
    state.values["target-context"] = {
      kpis: [{ key: "target", value: 100000 }],
    };
    state.values.list = {
      ...(state.values.list as object),
      summary: {
        count: 1,
        totalCentavos: 25000,
        priorCentavos: 20000,
        waiting: 1,
        overCredit: 0,
        unpriced: 0,
        targetCentavos: null,
      },
    };
    const html = renderToStaticMarkup(createElement(OrdersWorkspace));
    expect(html).toContain("25.0% of period target");
    expect(html).toContain("₱1,000.00");
    expect(html).toContain("Review target");
  });
  it("keeps unknown money distinct from a real zero", () => {
    expect(money(null)).toBe("Unknown");
    expect(money(0)).toBe("₱0.00");
    expect(creditLabel("unknown")).toBe("Credit unknown");
  });
  it("opens named lines, frozen price source, credit and history with a close action", () => {
    const html = renderToStaticMarkup(
      createElement(OrderDrawer, { id: "raw-order-id", onClose: vi.fn() }),
    );
    for (const text of [
      "Order detail",
      "Close order detail",
      "Canned food",
      "2 CS",
      "Office channel price",
      "Promotions applied",
      "Credit unknown",
      "Office Admin",
      "Buyer emailed",
      "Save decision",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("raw-history");
  });
  it("Escape closes the drawer and prevents the underlying page handling it", () => {
    const close = vi.fn(),
      preventDefault = vi.fn();
    drawerKeys(
      { key: "Escape", shiftKey: false, preventDefault },
      {} as HTMLElement,
      close,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
  it("does not offer self-approval when the server denies the action", () => {
    state.values.detail = {
      ...(state.values.detail as object),
      canDecide: false,
    };
    expect(
      renderToStaticMarkup(
        createElement(OrderDrawer, { id: "x", onClose: vi.fn() }),
      ),
    ).not.toContain("Save decision");
  });
  it("does not show stale rows after a refusal", () => {
    state.error = { message: "Outside your area" };
    const html = renderToStaticMarkup(createElement(OrdersWorkspace));
    expect(html).toContain("Outside your area");
    expect(html).not.toContain("Market Store");
  });
  it("builds the exact saved-view server filters", () => {
    expect(savedView("Waiting for my approval")).toEqual({
      view: "waiting",
      status: "pending_approval",
    });
    expect(savedView("Over credit")).toEqual({ view: "over", status: "" });
    expect(savedView("Rejected this week").status).toBe("rejected");
    expect(savedView("Today").from).toBe(savedView("Today").to);
  });
  it("mounts no denied content", () => {
    state.can = false;
    expect(renderToStaticMarkup(createElement(OrdersWorkspace))).toBe("");
  });
});
