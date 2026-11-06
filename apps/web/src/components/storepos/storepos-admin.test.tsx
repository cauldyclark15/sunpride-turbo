import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  StorePosAdmin,
  StoreShiftRows,
  storeStatus,
  type StorePosWorkspace,
} from "./storepos-admin";
const state = vi.hoisted(() => ({
  data: undefined as StorePosWorkspace | undefined,
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({ data: state.data }),
  useLive: () => {},
  mutate: vi.fn(),
}));
vi.mock("../cockpit/kit", () => ({
  Panel: ({ children }: { children: React.ReactNode }) => children,
}));
const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const shift = {
  id: "private-session-uuid",
  registerName: "Register one",
  storeName: "Cebu Colon",
  cashierName: "Sample cashier",
  serviceDate: "2026-10-21",
  openedAt: 1792530000000,
  closedAt: 1792533600000,
  status: "needs_review",
  declaredCentavos: "99000",
  expectedCentavos: null,
  varianceCentavos: null,
  closureId: null,
  canDecide: false,
};
describe("F-R01 Store cashier setup and blind review", () => {
  it("F-R01 exact cents never hides a one-cent blind cash discrepancy", () => {
    const view = html(
      createElement(StoreShiftRows, {
        shifts: [
          {
            ...shift,
            declaredCentavos: "100000",
            expectedCentavos: "100001",
            varianceCentavos: "-1",
            canDecide: true,
            closureId: "closure",
          },
        ],
        onDecide: vi.fn(),
      }),
    );
    expect(view).toContain("₱1,000.01");
    expect(view).toMatch(/[−-]₱0\.01/);
  });
  it("shows the opening float on the session line in pesos", () => {
    const view = html(
      createElement(StoreShiftRows, {
        shifts: [{ ...shift, openingFloatCentavos: "200000" }],
      }),
    );
    expect(view).toContain("Opening float");
    expect(view).toContain("₱2,000.00");
  });
  it("uses plain register/person labels and never renders private identifiers", () => {
    const view = html(createElement(StoreShiftRows, { shifts: [shift] }));
    expect(view).toContain("Cebu Colon");
    expect(view).toContain("Sample cashier");
    expect(view).toContain("₱990");
    expect(view).not.toContain(shift.id);
    expect(view).not.toContain("Expected");
    expect(view).not.toContain("Difference");
  });
  it("only renders expected, over/short and decision controls from the authorized server partition", () => {
    const view = html(
      createElement(StoreShiftRows, {
        shifts: [
          {
            ...shift,
            expectedCentavos: "100000",
            varianceCentavos: "-1000",
            canDecide: true,
            closureId: "private-closure",
          },
        ],
        onDecide: vi.fn(),
      }),
    );
    expect(view).toContain("Expected");
    expect(view).toContain("₱1,000");
    expect(view).toContain("Investigate");
    expect(view).not.toContain("private-closure");
  });
  it("adds a mode editor only for an active POS device returned to an administrator", () => {
    state.data = {
      locations: [],
      registers: [],
      devices: [
        { id: "pos", name: "H10P", mode: "store", register_id: "register" },
      ],
      people: [],
      shifts: [],
      canManage: true,
      truncated: false,
      transactionsEnabled: false,
    };
    const view = html(createElement(StorePosAdmin, { deviceId: "pos" }));
    expect(view).toContain("Current mode: Store");
    expect(view).toContain("Save POS mode");
    expect(view).toContain("sales, split tender, receipts and daily closing");
    expect(view).toContain("Allow manager-PIN mode switching");
    expect(
      html(createElement(StorePosAdmin, { deviceId: "field-phone" })),
    ).toBe("");
    state.data = { ...state.data, canManage: false };
    expect(html(createElement(StorePosAdmin, { deviceId: "pos" }))).toBe("");
    expect(storeStatus("needs_review")).toBe("Cash difference needs review");
  });
});
