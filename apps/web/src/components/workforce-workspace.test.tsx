import { describe, it, expect } from "vitest";
import { attendanceReading } from "./workforce-workspace";
type Person = Parameters<typeof attendanceReading>[0][number];
const person = (extra: Partial<Person> = {}): Person => ({
  id: "internal-test-key",
  name: "SAMPLE",
  unitName: "SAMPLE team",
  clockIn: null,
  clockOut: null,
  firstCall: null,
  lastCall: null,
  calls: 0,
  hours: null,
  attendance: "not_clocked",
  flags: [],
  changes: [],
  appliedId: null,
  sessionId: null,
  start: null,
  end: null,
  ...extra,
});
describe("F-222 workforce reading", () => {
  it("F-222 separates raw attendance, review, absence and leave without double-counting the expected roster", () => {
    const r = attendanceReading([
      person({ attendance: "clocked_in", start: 1, hours: 2 }),
      person({ attendance: "clocked_in", flags: ["low_accuracy"] }),
      person({ attendance: "absence" }),
      person({ attendance: "leave" }),
      person(),
    ]);
    expect(r).toEqual({
      staff: 5,
      expected: 4,
      clocked: 1,
      review: 1,
      absence: 1,
      leave: 1,
      missing: 1,
      hours: 2,
    });
    expect(r.clocked + r.review + r.absence + r.missing + r.leave).toBe(
      r.staff,
    );
  });
  it("F-222 an empty roster is not an invented zero-percent attendance target", () => {
    expect(attendanceReading([])).toEqual({
      staff: 0,
      expected: 0,
      clocked: 0,
      review: 0,
      absence: 0,
      leave: 0,
      missing: 0,
      hours: 0,
    });
  });
});
