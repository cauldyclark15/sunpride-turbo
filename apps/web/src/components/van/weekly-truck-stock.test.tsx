import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  mondayOf,
  shiftWeek,
  stockMoney,
  expectedLeftText,
  tripLabel,
  varianceText,
  reasonText,
  weekFlags,
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
  useApi: (key: string[]) => ({
    data:
      key[1] === "detail"
        ? {
            ...list.rows[0],
            cashier: { amountMinor: "125000" },
            lines: [
              {
                productId: "p1",
                name: "SAMPLE corned beef",
                code: "SAMPLE-A",
                uom: "PC",
                requestedBase: 100,
                servedBase: 80,
                shortfallBase: 20,
                soldBase: 48,
                expectedLeftBase: 32,
                countedBase: 30,
                varianceBase: 2,
                reasonName: "Missing",
                note: "Two short",
              },
              {
                productId: "p2",
                name: "SAMPLE never loaded",
                code: "SAMPLE-B",
                uom: "PC",
                requestedBase: 0,
                servedBase: 0,
                shortfallBase: 0,
                soldBase: 24,
                expectedLeftBase: -24,
                countedBase: 0,
                varianceBase: -24,
                reasonName: null,
                needsReason: true,
                note: null,
              },
            ],
          }
        : list,
    error: null,
  }),
}));
import { WeeklyTruckStock, WeekDetail } from "./weekly-truck-stock";
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
  it("sends products sold but never loaded to the office, not the salesman", () => {
    const base = { reasonName: null, needsReason: false, countedBase: 0 };
    expect(reasonText({ ...base, notLoaded: true })).toBe(
      "Sold but not loaded — check loading",
    );
    expect(reasonText({ ...base, needsReason: true })).toBe("No reason given");
    expect(reasonText({ ...base, reasonName: "Damaged" })).toBe("Damaged");
    expect(weekFlags({ missingReasons: 0, notLoaded: 2 })).toBe(
      " · 2 sold but not loaded",
    );
    expect(weekFlags({ missingReasons: 1 })).toBe(" · 1 without reason");
  });
  it("never shows negative stock left and names trips by day", () => {
    expect(expectedLeftText(32)).toBe("32");
    expect(expectedLeftText(-24)).toBe("0 (sold 24 more than loaded)");
    expect(
      tripLabel({ name: "SMP-TRIP-2026-11-16-0", serviceDate: "2026-11-16" }),
    ).toBe("Mon, Nov 16, 2026 · trip 1");
  });
  it("keeps the detail headers apart and flags over-sold products", () => {
    const html = renderToStaticMarkup(
      <WeekDetail id="w1" canManage onEdit={() => {}} />,
    );
    expect(html).toMatch(/\[&amp;_th\]:px-2|\[&_th\]:px-2/);
    expect(html).toContain("<th>Reason</th>");
    expect(html).not.toContain(">-24<");
    expect(html).toContain("0 (sold 24 more than loaded)");
    expect(html).toContain("sold more than was loaded");
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
  it("shows the four authorized print links and keeps stock value separate from cash due", () => {
    const html = renderToStaticMarkup(
      <WeekDetail id="w1" canManage onEdit={() => {}} />,
    );
    for (const report of ["request", "loading", "count", "cashier"])
      expect(html).toContain(`format=print&amp;report=${report}`);
    expect(html).toContain("PHP 1250.00");
    expect(html).toContain("not cash due");
    expect(html).toContain("SAMPLE corned beef");
  });
  it("never rounds a large centavo total through a floating-point number", () => {
    expect(stockMoney("90071992547409931")).toBe("PHP 900719925474099.31");
    expect(stockMoney("0")).toBe("PHP 0.00");
    expect(stockMoney(null)).toContain("Unavailable");
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
