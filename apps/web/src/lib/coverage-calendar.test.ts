import { describe, expect, it } from "vitest";
import {
  coverageMonthDays,
  currentManilaDate,
  currentManilaMonth,
  manilaInstantDate,
} from "./coverage-calendar";

describe("Manila coverage calendar", () => {
  it("builds February in leap and ordinary years with Sunday=0", () => {
    const leap = coverageMonthDays("2024-02");
    expect(leap).toHaveLength(29);
    expect(leap[0]).toEqual({ date: "2024-02-01", day: 1, weekday: 4 });
    expect(leap[28]).toEqual({ date: "2024-02-29", day: 29, weekday: 4 });
    expect(leap[3]?.weekday).toBe(0);
    expect(coverageMonthDays("2025-02")).toHaveLength(28);
  });
  it("builds a 31-day month across Sundays without host-local methods", () => {
    const days = coverageMonthDays("2026-03");
    expect(days).toHaveLength(31);
    expect(days[0]?.weekday).toBe(0);
    expect(days[30]).toEqual({ date: "2026-03-31", day: 31, weekday: 2 });
    expect(
      days.filter((day) => day.weekday === 0).map((day) => day.day),
    ).toEqual([1, 8, 15, 22, 29]);
  });
  it("round-trips a Manila day boundary", () => {
    expect(manilaInstantDate(Date.parse("2026-09-30T16:00:00Z"))).toBe(
      "2026-10-01",
    );
  });
  it("rejects malformed months and keeps current day/month in Manila", () => {
    expect(() => coverageMonthDays("2026-13")).toThrow();
    expect(currentManilaDate().slice(0, 7)).toBe(currentManilaMonth());
  });
});
