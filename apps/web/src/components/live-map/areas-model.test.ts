import { describe, expect, it } from "vitest";
import {
  bin,
  COLORS,
  compactMetric,
  fitCamera,
  legendRanges,
  placeLabels,
  shortAreaName,
  escapeAction,
  listIndex,
  metricValue,
  ordinal,
  periodDates,
  rankAreas,
  steps,
  type AreaFacts,
} from "./areas-model";
const facts: AreaFacts = {
  customers: 2,
  newCustomers: 1,
  sales: 2000,
  unknownSales: 0,
  done: 1,
  planned: 3,
  active: 1,
  sources: 2,
};
describe("area explorer colour steps and totals", () => {
  it("separates measured zero from no source or unknown money", () => {
    expect(metricValue(undefined, "sales")).toBeNull();
    expect(metricValue({ ...facts, sales: null }, "sales")).toBeNull();
    expect(metricValue({ ...facts, sales: 0 }, "sales")).toBe(0);
    expect(bin(null, [0, 10])).toBe(-1);
    expect(bin(0, [0, 10])).toBe(0);
  });
  it("uses finite numeric thresholds, deduplicating ties and empty inputs", () => {
    expect(steps([])).toEqual([]);
    expect(steps([null])).toEqual([]);
    expect(steps([5, 5, 5])).toEqual([]);
    expect(steps([0, 10, 20, 30, 40, 50])).toEqual([10, 20, 30, 40]);
    expect(bin(10, [10, 20])).toBe(0);
    expect(bin(11, [10, 20])).toBe(1);
    expect(bin(30, [10, 20])).toBe(2);
  });
  it("ranks ties by name and ID without mutating inputs, unknown last", () => {
    const input = [
      { id: "a", name: "Zamboanga", value: 10 },
      { id: "b", name: "Cebu", value: 10 },
      { id: "c", name: "Unknown", value: null },
      { id: "d", name: "Zero", value: 0 },
    ];
    expect(rankAreas(input).map((r) => [r.id, r.rank])).toEqual([
      ["b", 1],
      ["a", 2],
      ["d", 3],
      ["c", null],
    ]);
    expect(input[0]?.id).toBe("a");
  });
  it("formats exceptional ordinal suffixes", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
    ]);
  });
  it("visits rank by done, retaining planned independently", () => {
    expect(metricValue(facts, "visits")).toBe(1);
    expect(facts.planned).toBe(3);
  });
});
describe("area explorer polish", () => {
  it("keeps five distinct steps for sparse, unequal measurements", () => {
    expect(COLORS).toHaveLength(5);
    expect(new Set(COLORS).size).toBe(5);
    expect(steps([10, 50, null])).toEqual([10, 20, 30, 40]);
    expect(steps([1, 3])).toEqual([0.6, 1.2, 1.8, 2.4]);
    expect(legendRanges([150000, 400000], "sales").map((s) => s.label)).toEqual(
      ["₱0–800", "₱800–1.6K", "₱1.6K–2.4K", "₱2.4K–3.2K", "₱3.2K–4K"],
    );
  });
  it("labels a sole measured value exactly, not as all measured values", () => {
    expect(legendRanges([null, 1, 1], "customers")).toMatchObject([
      { label: "1", low: 1, high: 1, color: COLORS[4] },
    ]);
    expect(legendRanges([0], "customers")[0]?.label).toBe("0");
    expect(legendRanges([null], "sales")).toEqual([]);
    expect(compactMetric(150000, "sales")).toBe("₱1.5K");
  });
  it("fits the visible feature bounds tightly without distortion", () => {
    for (const [width, height] of [
      [650, 740],
      [300, 440],
    ]) {
      const bounds: [[number, number], [number, number]] = [
        [100, 200],
        [250, 500],
      ];
      const c = fitCamera(bounds, width!, height!);
      const x0 = bounds[0][0] * c.scale + c.x,
        x1 = bounds[1][0] * c.scale + c.x;
      const y0 = bounds[0][1] * c.scale + c.y,
        y1 = bounds[1][1] * c.scale + c.y;
      expect(x0).toBeGreaterThanOrEqual(11.99);
      expect(x1).toBeLessThanOrEqual(width! - 11.99);
      expect(y0).toBeGreaterThanOrEqual(11.99);
      expect(y1).toBeLessThanOrEqual(height! - 11.99);
      expect((x0 + x1) / 2).toBeCloseTo(width! / 2);
      expect((y0 + y1) / 2).toBeCloseTo(height! / 2);
      expect(Math.min(x0, y0)).toBeCloseTo(12);
    }
    expect(
      fitCamera(
        [
          [Infinity, Infinity],
          [-Infinity, -Infinity],
        ],
        650,
        740,
      ),
    ).toEqual({ x: 0, y: 0, scale: 1 });
  });
  it("keeps clustered top-area labels inside the map without collisions", () => {
    const labels = placeLabels(
      ["Cebu", "Lapu-Lapu", "Mandaue"].map((name, i) => ({
        id: name,
        name,
        value: 3 - i,
        x: 200 + i * 3,
        y: 300 + i * 3,
      })),
      400,
      700,
    );
    labels.forEach((a, i) => {
      expect(a.left).toBeGreaterThanOrEqual(8);
      expect(a.left + a.width).toBeLessThanOrEqual(392);
      expect(a.top).toBeGreaterThanOrEqual(8);
      expect(a.top + a.height).toBeLessThanOrEqual(692);
      labels
        .slice(i + 1)
        .forEach((b) =>
          expect(
            a.left < b.left + b.width &&
              a.left + a.width > b.left &&
              a.top < b.top + b.height &&
              a.top + a.height > b.top,
          ).toBe(false),
        );
    });
    const keepout = { left: 175, top: 275, width: 80, height: 100 };
    const clear = placeLabels(
      [{ id: "Cebu", name: "Cebu", value: 1, x: 200, y: 300 }],
      400,
      700,
      [keepout],
    )[0]!;
    expect(
      clear.left < keepout.left + keepout.width &&
        clear.left + clear.width > keepout.left &&
        clear.top < keepout.top + keepout.height &&
        clear.top + clear.height > keepout.top,
    ).toBe(false);
  });
  it("uses readable region breadcrumb names without guessing other names", () => {
    expect(shortAreaName("Region VII (Central Visayas)")).toBe(
      "Central Visayas",
    );
    expect(shortAreaName("Cebu")).toBe("Cebu");
  });
});

describe("area explorer keyboard and period flow", () => {
  it("arrows are bounded; Home/End reach the visible first/last row", () => {
    expect(listIndex("ArrowUp", 0, 18)).toBe(0);
    expect(listIndex("ArrowDown", 17, 18)).toBe(17);
    expect(listIndex("ArrowDown", 0, 18)).toBe(1);
    expect(listIndex("ArrowUp", 3, 18)).toBe(2);
    expect(listIndex("Home", 8, 18)).toBe(0);
    expect(listIndex("End", 8, 18)).toBe(17);
    expect(listIndex("End", 0, 0)).toBe(0);
  });
  it("Escape clears a pinned range before going up, including no-data", () => {
    expect(escapeAction(0, 2)).toBe("unpin");
    expect(escapeAction(-1, 0)).toBe("unpin");
    expect(escapeAction(null, 3)).toBe("back");
    expect(escapeAction(null, 0)).toBe("none");
  });
  it("period includes today and uses Manila calendar strings", () => {
    expect(periodDates("week", "2026-11-26")).toEqual({
      from: "2026-11-20",
      to: "2026-11-26",
    });
    expect(periodDates("month", "2026-11-26").from).toBe("2026-11-01");
    expect(periodDates("today", "2026-11-26").from).toBe("2026-11-26");
  });
});
