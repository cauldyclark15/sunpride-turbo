import { describe, expect, it } from "vitest";
import {
  bin,
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
