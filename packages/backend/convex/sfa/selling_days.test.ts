import { describe, expect, it } from "vitest";
import {
  isSellingDay,
  perDiemBasis,
  sellingDatesInMonth,
  weekdayOf,
} from "./selling_days";

describe("six-day selling week (call 2026-10-02)", () => {
  it("treats Monday to Saturday as selling days and Sunday as not", () => {
    // 2026-10-03 is a Saturday, 2026-10-04 a Sunday, 2026-10-05 a Monday.
    expect(weekdayOf("2026-10-03")).toBe(6);
    expect(isSellingDay("2026-10-03")).toBe(true);
    expect(isSellingDay("2026-10-04")).toBe(false);
    expect(isSellingDay("2026-10-05")).toBe(true);
  });

  it("counts Saturdays in the month's selling days for monthly targets", () => {
    const october = sellingDatesInMonth("2026-10");
    // October 2026 has 31 days and 4 Sundays.
    expect(october).toHaveLength(27);
    expect(october).toContain("2026-10-31"); // a Saturday
    expect(october).not.toContain("2026-10-25"); // a Sunday
  });

  it("follows a position's own selling week when one is recorded", () => {
    expect(isSellingDay("2026-10-03", [1, 2, 3, 4, 5])).toBe(false);
  });

  it("bases per diem on work actually done on a selling day", () => {
    expect(perDiemBasis({ serviceDate: "2026-10-03", calls: 4 })).toBe(
      "eligible",
    );
    expect(perDiemBasis({ serviceDate: "2026-10-03", calls: 0 })).toBe(
      "no_activity",
    );
    expect(perDiemBasis({ serviceDate: "2026-10-04", calls: 2 })).toBe(
      "needs_review",
    );
  });

  it("rejects malformed dates", () => {
    expect(() => weekdayOf("2026-02-30")).toThrow();
    expect(() => weekdayOf("03/10/2026")).toThrow();
    expect(() => sellingDatesInMonth("2026-13")).toThrow();
  });
});
