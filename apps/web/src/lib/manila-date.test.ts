import { afterEach, describe, expect, it, vi } from "vitest";
import {
  futureManilaDateToUtcMs,
  manilaDateToUtcMs,
  todayOrFutureManilaDateToUtcMs,
} from "./manila-date";

afterEach(() => vi.restoreAllMocks());

describe("Asia/Manila date-only conversion", () => {
  it("converts midnight to the preceding UTC day", () => {
    expect(new Date(manilaDateToUtcMs("2026-09-26")).toISOString()).toBe(
      "2026-09-25T16:00:00.000Z",
    );
    expect(new Date(manilaDateToUtcMs("2024-02-29")).toISOString()).toBe(
      "2024-02-28T16:00:00.000Z",
    );
    expect(new Date(manilaDateToUtcMs("2027-01-01")).toISOString()).toBe(
      "2026-12-31T16:00:00.000Z",
    );
  });
  it("rejects invalid dates rather than rolling over", () => {
    expect(() => manilaDateToUtcMs("2026-02-29")).toThrow("Invalid date");
    expect(() => manilaDateToUtcMs("09/26/2026")).toThrow("Invalid date");
  });
  it.each([
    ["2026-11-18T16:00:00.000Z", "2026-11-19", "2026-11-18"],
    ["2026-11-19T04:00:00.000Z", "2026-11-19", "2026-11-18"],
    ["2026-11-19T15:59:59.999Z", "2026-11-19", "2026-11-18"],
    ["2026-11-19T16:00:00.000Z", "2026-11-20", "2026-11-19"],
  ])(
    "accepts today's Manila date at %s but refuses the previous day",
    (now, today, yesterday) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
      expect(todayOrFutureManilaDateToUtcMs(today)).toBe(
        manilaDateToUtcMs(today),
      );
      expect(() => todayOrFutureManilaDateToUtcMs(yesterday)).toThrow(
        "Choose today or a future effective date.",
      );
      expect(todayOrFutureManilaDateToUtcMs("2099-01-01")).toBe(
        manilaDateToUtcMs("2099-01-01"),
      );
    },
  );
  it("keeps invalid date validation for same-day territory starts", () => {
    expect(() => todayOrFutureManilaDateToUtcMs("2099-02-29")).toThrow(
      "Invalid date",
    );
  });
  it("rejects date-only values whose Manila midnight has already passed", () => {
    expect(() => futureManilaDateToUtcMs("2020-01-01")).toThrow(
      "Choose a future effective date.",
    );
    expect(futureManilaDateToUtcMs("2099-01-01")).toBe(
      manilaDateToUtcMs("2099-01-01"),
    );
  });
});
