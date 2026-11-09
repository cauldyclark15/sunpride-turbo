import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutsideCallOrders } from "./outside-call-orders";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  permissions: [] as string[],
  profile: { id: "", role: "" },
  queries: [] as unknown[],
  target: null as unknown,
  error: null as { message: string } | null,
}));
vi.mock("../lib/api", () => ({
  useApi: (key: unknown[]) => {
    state.queries.push(key);
    return {
      data: key ? state.values[String(key[1])] : undefined,
      error: key?.[1] === "outside-calls" ? state.error : null,
    };
  },
  useLive: vi.fn(),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  useSession: () => ({ profile: state.profile }),
  usePermissions: () => ({ can: (c: string) => state.permissions.includes(c) }),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [
      initial === null && state.target
        ? state.target
        : typeof initial === "function"
          ? (initial as () => unknown)()
          : initial,
      vi.fn(),
    ],
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
  total: rows.length,
});
const render = () => renderToStaticMarkup(createElement(OutsideCallOrders));
beforeEach(() => {
  state.queries = [];
  state.target = null;
  state.error = null;
  state.permissions = ["order.encode", "visit.read"];
  state.profile = { id: "admin-profile", role: "operations" };
  state.values = {
    "outside-calls": page([row]),
    "outside-options": {
      outlets: [
        {
          _id: "o1",
          name: "Puregold Cubao",
          code: "SP000123",
          status: "active",
        },
        {
          _id: "o2",
          name: "Closed store",
          code: "SP000999",
          status: "inactive",
        },
      ],
      products: [
        {
          _id: "p1",
          name: "Pineapple Juice 1L",
          code: "P-1",
          uom: "CS",
          active: true,
        },
        { _id: "p9", name: "Retired", code: "P-9", uom: "CS", active: false },
      ],
    },
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
    expect(view).not.toContain("Add activity");
    // No selected store, hence no candidate request; there is only one server-scoped list.
    expect(state.queries).toContain(null);
    expect(
      state.queries.filter((x) => Array.isArray(x) && x[1] === "outside-calls"),
    ).toHaveLength(1);
  });
  it("shows the salesperson only their own POs with Add activity", () => {
    state.permissions = ["visit.read", "visit.record"];
    state.profile = { id: "ana-profile", role: "sales" };
    const view = render();
    expect(view).toContain("My outside-call POs");
    expect(view).not.toContain("Encode a store PO");
    expect(view).toMatch(/>Add activity<\/button>/);
    expect(view).not.toContain("Cancel PO");
    expect(state.queries).toHaveLength(1);
  });
  it("shows the activity form with every other productive activity", () => {
    state.permissions = ["visit.read", "visit.record"];
    state.profile = { id: "ana-profile", role: "sales" };
    state.target = { id: "po-1", action: "record" };
    const view = render();
    expect(view).toContain("How you reached the store");
    expect(view).toContain("Collection");
    expect(view).toContain("Bad order (BO) pickup");
    expect(view).toContain("purchase order is always included");
    expect(view).toContain("Save activity");
  });
  it("shows a recorded activity to supervisors without actions", () => {
    state.permissions = ["visit.read", "visit.record"];
    state.profile = { id: "manager-profile", role: "manager" };
    state.values["outside-calls"] = page([
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
    expect(view).not.toContain("Add activity");
    expect(view).not.toContain("Cancel PO");
  });
  it("renders nothing without access", () => {
    state.permissions = [];
    expect(render()).toBe("");
    expect(state.queries).toEqual([null]);
  });
  it("shows a server refusal instead of an empty successful list", () => {
    state.error = { message: "Your access changed" };
    expect(render()).toContain("Your access changed");
    expect(render()).not.toContain("PO PO-1001");
  });
  it("keeps a next page visible even when the current filtered page is empty", () => {
    state.values["outside-calls"] = {
      ...page([]),
      isDone: false,
      continueCursor: "20",
    };
    expect(render()).toContain("Outside-call PO pages");
    expect(render()).toContain("No POs here.");
  });
});
