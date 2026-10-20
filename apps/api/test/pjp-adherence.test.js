import { expect, test } from "bun:test";
import {
  adherenceFacts,
  adherenceWindow,
} from "../src/domains/coverage/adherence.js";
const date = "2026-10-20";
const window = adherenceWindow(date);
/** @param {number} actual @param {number} [planned] */
function fixture(actual, planned = 100) {
  const slots = [];
  /** @type {any[]} */ const executions = [];
  for (const from of window.weeks)
    for (let i = 0; i < planned; i++) {
      const id = `${from}:${i}`;
      slots.push({
        date: from,
        profileId: "rep",
        person: "Rep",
        beatId: "beat",
        beat: "North",
        territoryId: "area",
        territory: "Cebu",
        outletId: `o${i}`,
        outlet: `Store ${i}`,
        plannedVisitId: id,
      });
      if (i < actual)
        executions.push({ planned_visit_id: id, state: "checked-out" });
    }
  return { slots, executions };
}
test("F-206 four complete weeks use Manila Monday boundaries and exclude current partial week", () => {
  expect(window).toEqual({
    from: "2026-09-21",
    to: "2026-10-18",
    priorFrom: "2026-08-24",
    priorTo: "2026-09-20",
    weeks: ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"],
  });
  expect(adherenceWindow("2026-10-19")).toEqual(window);
});
test("F-206 exactly 85% does not pass the above-85 exit criterion; four 86% weeks do", () => {
  const f = fixture(85);
  expect(adherenceFacts(f.slots, f.executions, date).fourWeekGate).toBe(
    "not_met",
  );
  const g = fixture(86);
  const result = adherenceFacts(g.slots, g.executions, date);
  expect(result.fourWeekGate).toBe("passed");
  expect(result.summary).toEqual({
    planned: 400,
    actual: 344,
    adherencePct: 86,
  });
});
test("F-206 duplicates, open, rejected and off-plan calls never inflate adherence or outlet frequency", () => {
  const f = fixture(1, 2);
  f.executions.push(
    { ...f.executions[0] },
    { planned_visit_id: "off-plan", state: "checked-out" },
    { planned_visit_id: f.slots[1].plannedVisitId, state: "in-progress" },
    {
      planned_visit_id: f.slots[1].plannedVisitId,
      state: "checked-out",
      late_review_status: "rejected",
    },
  );
  const result = adherenceFacts(f.slots, f.executions, date);
  expect(result.summary).toEqual({ planned: 8, actual: 4, adherencePct: 50 });
  expect(result.frequency.find((r) => r.outletId === "o0")?.actual).toBe(4);
  expect(result.rows[0]).toMatchObject({
    person: "Rep",
    beat: "North",
    territory: "Cebu",
    planned: 2,
    actual: 1,
  });
});
test("F-206 missing weeks are unknown, never a passed pilot gate", () => {
  expect(adherenceFacts([], [], date).fourWeekGate).toBe("insufficient_plan");
  expect(adherenceFacts([], [], date).summary.adherencePct).toBeNull();
});
