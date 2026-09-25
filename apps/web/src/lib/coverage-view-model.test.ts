import { describe, expect, it } from "vitest";
import { calendarBucket, groupCalendar } from "./coverage-view-model";
describe("Manila calendar grouping", () => {
  it("groups Sep 28–30 together and crosses into October in the same Monday week", () => {
    expect(
      ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"].map((x) =>
        calendarBucket(x, "week"),
      ),
    ).toEqual(Array(4).fill("2026-09-28"));
    expect(calendarBucket("2026-09-27", "week")).toBe("2026-09-21");
    expect(
      groupCalendar(
        [
          { serviceDate: "2026-09-30", slotKey: "a", sequence: 1 },
          { serviceDate: "2026-10-01", slotKey: "b", sequence: 1 },
        ],
        "month",
      ),
    ).toHaveLength(2);
  });
});
