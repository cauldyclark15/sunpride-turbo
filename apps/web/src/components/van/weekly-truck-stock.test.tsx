import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  mondayOf,
  shiftWeek,
  varianceText,
  weekSaveBody,
} from "./weekly-truck-stock-model";

const list = {
  weekStart: "2026-11-16",
  canManage: true,
  rows: [
    {
      id: "w1",
      weekStart: "2026-11-16",
      salespersonProfileId: "s1",
      seller: "SAMPLE seller",
      status: "counted",
      countedAt: 1,
      reviewedAt: null,
      reviewNote: null,
      updatedAt: "v",
      lineCount: 1,
      totals: {
        requestedBase: 100,
        servedBase: 80,
        shortfallBase: 20,
        soldBase: 48,
        countedBase: 30,
        varianceBase: 2,
        missingReasons: 1,
      },
    },
  ],
  sellers: [{ id: "s1", name: "SAMPLE seller" }],
  products: [],
};
vi.mock("../../lib/api", () => ({
  mutate: vi.fn(),
  useLive: vi.fn(),
  useApi: () => ({ data: list, error: null }),
}));
import { WeeklyTruckStock } from "./weekly-truck-stock";
import { stockReasonSaveBody } from "../spec-masters/reference-masters";

describe("SP-0227 weekly truck stock", () => {
  it("works on Monday weeks", () => {
    expect(mondayOf("2026-11-21")).toBe("2026-11-16");
    expect(mondayOf("2026-11-22")).toBe("2026-11-16");
    expect(shiftWeek("2026-11-16", 1)).toBe("2026-11-23");
  });
  it("says differences in plain words", () => {
    expect(varianceText(null)).toBe("Not counted yet");
    expect(varianceText(0)).toBe("Balanced");
    expect(varianceText(2)).toBe("2 missing");
    expect(varianceText(-3)).toBe("3 extra");
  });
  it("builds the save command from requested and actually loaded", () => {
    expect(weekSaveBody("", "2026-11-16", [])).toEqual({
      ok: false,
      error: "Choose the salesman.",
    });
    expect(
      weekSaveBody("s1", "2026-11-16", [
        { productId: "p", requested: "1.5", served: "1" },
      ]).ok,
    ).toBe(false);
    expect(
      weekSaveBody(
        "s1",
        "2026-11-16",
        [
          { productId: "p", requested: "100", served: "80" },
          { productId: "", requested: "", served: "" },
        ],
        "v1",
      ),
    ).toEqual({
      ok: true,
      body: {
        salespersonProfileId: "s1",
        weekStart: "2026-11-16",
        lines: [{ productId: "p", requestedBase: 100, servedBase: 80 }],
        baseUpdatedAt: "v1",
      },
    });
  });
  it("shows the week's reconciliation with CSV export", () => {
    const html = renderToStaticMarkup(<WeeklyTruckStock />);
    expect(html).toContain("SAMPLE seller");
    expect(html).toContain("2 missing");
    expect(html).toContain("1 without reason");
    expect(html).toContain("counts him for what was actually loaded");
    expect(html).toContain("format=csv");
  });
  it("sends stock reason add and retire commands", () => {
    const values: Record<string, string> = {
      name: " Expired ",
      reason: "Office list",
    };
    const form = { get: (k: string) => values[k] ?? null };
    expect(stockReasonSaveBody(form)).toEqual({
      name: "Expired",
      reason: "Office list",
      active: true,
    });
    expect(
      stockReasonSaveBody(form, {
        id: "r",
        code: "expired",
        name: "Expired",
        active: true,
        updatedAt: "v",
      }),
    ).toMatchObject({ id: "r", active: false, baseUpdatedAt: "v" });
  });
});
