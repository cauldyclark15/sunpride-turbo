import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DecidedDamage,
  VanDamageApprovals,
  damageErrorMessage,
  damageReasonLabel,
  formatDamageQuantity,
} from "./van-damage-approvals";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  status: "exhausted" as string,
  paginated: [] as unknown[],
  mutations: [] as Array<{ name: string; args: unknown }>,
  buttons: [] as Array<{ label: string; onPress: () => void }>,
  setters: [] as Array<(value: unknown) => void>,
  notes: {} as Record<string, string>,
}));

vi.mock("../lib/api", () => ({
  useApiPages: (key: unknown) => {
    state.paginated.push({ key });
    return { items: state.rows, status: state.status, loadMore: vi.fn() };
  },
  useLive: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("./van/use-command", () => ({
  useVanCommand: (name: string) =>
    vi.fn(async (args: unknown) => {
      state.mutations.push({ name, args });
      return null;
    }),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      initial !== null && typeof initial === "object"
        ? [state.notes, vi.fn()]
        : [initial, vi.fn()],
  };
});
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    onPress,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
  }) => {
    if (onPress && typeof children === "string")
      state.buttons.push({ label: children, onPress });
    return createElement("button", null, children);
  },
  Input: (props: Record<string, unknown>) =>
    createElement("input", { "aria-label": props["aria-label"] }),
}));
vi.mock("@sunpride/ui", () => ({
  Card: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement("section", null, createElement("h2", null, label), children),
  Notice: ({ title }: { title: string }) => createElement("p", null, title),
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  WorkspaceIcon: () => null,
}));

const row = (patch: Record<string, unknown> = {}) => ({
  damageId: "d1",
  tripId: "t1",
  tripNumber: "TRIP-001",
  serviceDate: "2026-10-06",
  orgUnitId: "u1",
  sellerName: "Juan Seller",
  productCode: "SP-PJ-1L",
  productName: "Pineapple juice 1L",
  uomCode: "PC",
  quantityBase: 12_500n,
  quantityScale: 1000n,
  reason: "spoiled",
  note: "Sour smell",
  photoUrl: "https://files.example/photo.jpg",
  needsApproval: true,
  status: "pending_approval",
  recordedAt: Date.parse("2026-10-06T02:00:00Z"),
  decidedAt: null,
  decisionNote: null,
  canDecide: true,
  ...patch,
});

const render = () => renderToStaticMarkup(createElement(VanDamageApprovals));

beforeEach(() => {
  state.rows = [];
  state.status = "exhausted";
  state.paginated = [];
  state.mutations = [];
  state.buttons = [];
  state.notes = {};
});

describe("truck damage approvals (VAN-020)", () => {
  it("formats base quantities in selling units without float rounding", () => {
    expect(formatDamageQuantity(12_000n, 1000n)).toBe("12");
    expect(formatDamageQuantity(12_500n, 1000n)).toBe("12.5");
    expect(formatDamageQuantity(1n, 1000n)).toBe("0.001");
    expect(formatDamageQuantity(7n, 1n)).toBe("7");
    expect(formatDamageQuantity(7n, 3n)).toBe("7/3");
    expect(damageReasonLabel("spoiled")).toBe("Spoiled");
    expect(damageErrorMessage({ data: "Not yours" })).toBe("Not yours");
    expect(damageErrorMessage(new Error("x"))).toBe("x");
    expect(damageErrorMessage({})).toBe("Action failed. Try again.");
  });

  it("lists pending records with photo, note and both decisions", async () => {
    state.rows = [row()];
    const html = render();
    expect(state.paginated).toEqual([
      {
        key: ["van", "damage"],
      },
    ]);
    expect(html).toContain("Truck damage");
    expect(html).toContain("Pineapple juice 1L");
    expect(html).toContain("12.5");
    expect(html).toContain("Spoiled");
    expect(html).toContain("Juan Seller");
    expect(html).toContain("TRIP-001");
    expect(html).toContain("Sour smell");
    expect(html).toContain('src="https://files.example/photo.jpg"');
    expect(html).toContain("Decision note for SP-PJ-1L");
    state.buttons.find((button) => button.label === "Approve")!.onPress();
    await Promise.resolve();
    expect(state.mutations).toEqual([
      {
        name: "/api/v1/van/damage/decide",
        args: { damageId: "d1", decision: "approve" },
      },
    ]);
  });

  it("never rejects without a note, and sends the note when given", async () => {
    state.rows = [row()];
    render();
    state.buttons.find((button) => button.label === "Reject")!.onPress();
    await Promise.resolve();
    expect(state.mutations).toEqual([]);
    state.notes = { d1: " Label only " };
    state.buttons = [];
    render();
    state.buttons.find((button) => button.label === "Reject")!.onPress();
    await Promise.resolve();
    expect(state.mutations).toEqual([
      {
        name: "/api/v1/van/damage/decide",
        args: { damageId: "d1", decision: "reject", note: "Label only" },
      },
    ]);
  });

  it("hides decisions the caller may not take and shows empty and paging states", () => {
    state.rows = [row({ canDecide: false, photoUrl: null })];
    state.status = "canLoadMore";
    const html = render();
    expect(html).toContain("No photo");
    expect(html).toContain("Another supervisor decides this one");
    expect(html).not.toContain(">Approve<");
    expect(html).toContain("Show older");
    state.rows = [];
    state.status = "exhausted";
    expect(render()).toContain("No truck damage waiting");
  });

  it("WEB-112: Show older reveals decided records with outcome and who decided", () => {
    state.rows = [row()];
    const html = render();
    expect(html).toContain("Show older");
    state.buttons = [];
    state.paginated = [];
    state.rows = [
      row({ damageId: "d2", status: "approved", canDecide: false, decidedByName: "Maria Manager", decidedAt: Date.parse("2026-10-06T03:00:00Z"), decisionNote: "Seen on photo" }),
      row({ damageId: "d3", status: "rejected", canDecide: false, decidedByName: "Maria Manager", decidedAt: Date.parse("2026-10-06T04:00:00Z"), decisionNote: "Good stock" }),
    ];
    const decided = renderToStaticMarkup(createElement(DecidedDamage));
    expect(state.paginated).toEqual([{ key: ["van", "damage", "decided"] }]);
    expect(decided).toContain("Approved by Maria Manager");
    expect(decided).toContain("Seen on photo");
    expect(decided).toContain("Rejected by Maria Manager");
    expect(decided).toContain("Good stock");
    expect(decided).not.toContain("Decision note for");
  });
});
