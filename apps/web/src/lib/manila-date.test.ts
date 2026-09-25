import { describe, expect, it } from "vitest";
import { futureManilaDateToUtcMs, manilaDateToUtcMs } from "./manila-date";

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
  it("rejects date-only values whose Manila midnight has already passed", () => {
    expect(() => futureManilaDateToUtcMs("2020-01-01")).toThrow(
      "Choose a future effective date.",
    );
    expect(futureManilaDateToUtcMs("2099-01-01")).toBe(
      manilaDateToUtcMs("2099-01-01"),
    );
  });
});
