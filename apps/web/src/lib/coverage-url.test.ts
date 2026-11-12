import { describe, expect, it } from "vitest";
import {
  coverageSelectionFromParams,
  coverageSelectionPatch,
} from "./coverage-url";

describe("coverage URL state (WEB-113/114)", () => {
  it("reopens the month, person and plan from the URL after reload", () => {
    const s = coverageSelectionFromParams(
      new URLSearchParams("tab=plan&month=2026-12&person=p1&plan=plan-9"),
    );
    expect(s.month).toBe("2026-12");
    expect(s.personId).toBe("p1");
    expect(s.selected).toEqual({ id: "plan-9", assigneeId: "p1", assigneeName: "" });
  });
  it("falls back to the Manila month and no plan", () => {
    const s = coverageSelectionFromParams(
      new URLSearchParams("month=garbage"),
      new Date("2026-11-30T17:00:00Z"),
    );
    expect(s.month).toBe("2026-12");
    expect(s.selected).toBeNull();
  });
  it("writes a changed planner selection and skips an unchanged one", () => {
    const params = new URLSearchParams("tab=plan&month=2026-11&person=p1");
    expect(
      coverageSelectionPatch(params, { month: "2026-11", personId: "p1", planId: "x" }),
    ).toEqual({ month: "2026-11", person: "p1", plan: "x" });
    expect(
      coverageSelectionPatch(params, { month: "2026-11", personId: "p1", planId: null }),
    ).toBeNull();
  });
});
