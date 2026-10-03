import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutsideCallOrders } from "./outside-call-orders";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  queries: [] as { name: string; args: unknown }[],
  target: null as unknown,
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never);
    state.queries.push({ name, args });
    return args === "skip" ? undefined : state.values[name];
  },
  useMutation: () => vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === null && state.target) return [state.target, vi.fn()];
      return [
        typeof initial === "function" ? (initial as () => unknown)() : initial,
        vi.fn(),
      ];
    },
  };
});

const order = {
  _id: "po-1",
  poNumber: "PO-1001",
  serviceDate: "2026-09-28",
  receivedVia: "viber",
  status: "awaiting_activity",
  salespersonProfileId: "ana-profile",
  encodedAt: Date.parse("2026-09-28T03:00:00Z"),
  lines: [
    { productName: "Pineapple Juice 1L", quantity: 10, uom: "CS" },
    { productName: "Mango Syrup", quantity: 2, uom: "CS" },
  ],
  note: "Buyer emailed",
};
const row = {
  order,
  outletName: "Puregold Cubao",
  outletCode: "SP000123",
  salespersonName: "Ana Reyes",
  encodedByName: "Liza Admin",
};
const page = (rows: unknown[]) => ({
  page: rows,
  isDone: true,
  continueCursor: "",
});
const render = () => renderToStaticMarkup(createElement(OutsideCallOrders));
const named = (name: string) =>
  state.queries.filter((query) => query.name === name).map((q) => q.args);

beforeEach(() => {
  state.queries = [];
  state.target = null;
  state.values = {
    "lib/capabilities:currentPermissions": {
      capabilities: ["order.encode", "visit.read"],
    },
    "domains/profiles:current": { _id: "admin-profile", role: "operations" },
    "orders/outside_calls:list": page([row]),
    "orders/outside_calls:mine": page([]),
    "outlets/queries:list": page([
      { _id: "o1", name: "Puregold Cubao", code: "SP000123", status: "active" },
      { _id: "o2", name: "Closed store", code: "SP000999", status: "inactive" },
    ]),
    "domains/masterData:products": [
      {
        _id: "p1",
        name: "Pineapple Juice 1L",
        code: "P-1",
        uom: "CS",
        active: true,
      },
      { _id: "p9", name: "Retired", code: "P-9", uom: "CS", active: false },
    ],
  };
});

describe("Outside-call POs (CALL-09)", () => {
  it("gives the sales admin the encode form and the scoped list with cancel", () => {
    const view = render();
    expect(view).toContain("Encode a store PO");
    expect(view).toContain("Puregold Cubao (SP000123)");
    expect(view).not.toContain("Closed store");
    expect(view).toContain("Pineapple Juice 1L (P-1, CS)");
    expect(view).not.toContain("Retired");
    expect(view).toContain("Puregold Cubao · PO PO-1001");
    expect(view).toContain("for Ana Reyes · encoded by Liza Admin");
    expect(view).toContain("10 CS Pineapple Juice 1L, 2 CS Mango Syrup");
    expect(view).toContain("Waiting for salesperson");
    expect(view).toContain("not counted as calls");
    expect(view).toMatch(/>Cancel PO<\/button>/);
    expect(view).not.toContain("Record activity");
    // No store chosen yet, so no salesperson lookup.
    expect(named("orders/outside_calls:candidates")).toEqual(["skip"]);
    expect(named("orders/outside_calls:mine")).toEqual(["skip"]);
  });

  it("shows the salesperson only their own POs with Record activity", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["visit.read", "visit.record"],
    };
    state.values["domains/profiles:current"] = {
      _id: "ana-profile",
      role: "sales",
    };
    state.values["orders/outside_calls:mine"] = page([row]);
    const view = render();
    expect(view).toContain("My outside-call POs");
    expect(view).not.toContain("Encode a store PO");
    expect(view).toMatch(/>Record activity<\/button>/);
    expect(view).not.toContain("Cancel PO");
    expect(named("orders/outside_calls:list")).toEqual(["skip"]);
  });

  it("shows the activity form with every other productive activity", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["visit.read", "visit.record"],
    };
    state.values["domains/profiles:current"] = {
      _id: "ana-profile",
      role: "sales",
    };
    state.values["orders/outside_calls:mine"] = page([row]);
    state.target = { id: "po-1", action: "record" };
    const view = render();
    expect(view).toContain("How you reached the store");
    expect(view).toContain("Collection");
    expect(view).toContain("Bad order (BO) pickup");
    expect(view).toContain("purchase order is always included");
    expect(view).toContain("Save activity");
  });

  it("shows a recorded activity to supervisors without actions", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["visit.read", "visit.record"],
    };
    state.values["domains/profiles:current"] = {
      _id: "manager-profile",
      role: "manager",
    };
    state.values["orders/outside_calls:list"] = page([
      {
        ...row,
        order: {
          ...order,
          status: "activity_recorded",
          activity: {
            contact: "phone",
            codes: ["purchase_order", "collection"],
            note: "Delivery Wednesday",
            recordedAt: order.encodedAt,
          },
        },
      },
    ]);
    const view = render();
    expect(view).toContain("Activity recorded");
    expect(view).toContain(
      "Phone call · Purchase order, Collection · Delivery Wednesday",
    );
    expect(view).not.toContain("Record activity");
    expect(view).not.toContain("Cancel PO");
  });

  it("renders nothing without access", () => {
    state.values["lib/capabilities:currentPermissions"] = { capabilities: [] };
    expect(render()).toBe("");
  });
});
