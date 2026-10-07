import { describe, expect, it } from "vitest";
import * as backend from "../../../../packages/backend/convex/analytics/exception_model";
import { MAX_PERIOD_DAYS as BACKEND_MAX_DAYS } from "../../../../packages/backend/convex/analytics/productivity_model";
import {
  BEHIND_PLAN_PCT,
  emptyFieldTotals,
  hoursSince,
  MAX_PERIOD_DAYS,
  mergeFieldTotals,
  MIN_PLANNED_FOR_BEHIND,
  monthStart,
  OOS_OUTLET_MIN,
  OOS_PRODUCT_MIN_OUTLETS,
  periodDays,
  periodProblem,
  REPEAT_GEOFENCE_MIN,
  SAP_KIND_LABELS,
  TRIP_STATUS_LABELS,
} from "./management-exceptions";

describe("management exception view rules", () => {
  it("keeps thresholds and totals equal to the backend", () => {
    expect({
      BEHIND_PLAN_PCT,
      MIN_PLANNED_FOR_BEHIND,
      REPEAT_GEOFENCE_MIN,
      OOS_OUTLET_MIN,
      OOS_PRODUCT_MIN_OUTLETS,
      MAX_PERIOD_DAYS,
    }).toEqual({
      BEHIND_PLAN_PCT: backend.BEHIND_PLAN_PCT,
      MIN_PLANNED_FOR_BEHIND: backend.MIN_PLANNED_FOR_BEHIND,
      REPEAT_GEOFENCE_MIN: backend.REPEAT_GEOFENCE_MIN,
      OOS_OUTLET_MIN: backend.OOS_OUTLET_MIN,
      OOS_PRODUCT_MIN_OUTLETS: backend.OOS_PRODUCT_MIN_OUTLETS,
      MAX_PERIOD_DAYS: BACKEND_MAX_DAYS,
    });
    expect(emptyFieldTotals()).toEqual(backend.emptyFieldTotals());
    const a = backend.fieldTotals([
      { reasons: ["plan"], missedHighValueCount: 2 },
    ]);
    const b = backend.fieldTotals([
      { reasons: ["sales"], missedHighValueCount: 0 },
    ]);
    expect(mergeFieldTotals(a, b)).toEqual(backend.mergeFieldTotals(a, b));
    // Every backend trip status and SAP kind has a label.
    for (const status of backend.UNCLOSED_TRIP_STATUSES)
      expect(TRIP_STATUS_LABELS[status]).toBeTruthy();
    expect(Object.keys(SAP_KIND_LABELS).sort()).toEqual([
      "dead_letter",
      "failed",
      "stuck",
    ]);
  });

  it("defaults to month to date and refuses bad periods before asking", () => {
    expect(monthStart("2026-09-30")).toBe("2026-09-01");
    expect(periodDays("2026-09-01", "2026-09-30")).toBe(30);
    expect(periodProblem("2026-09-01", "2026-09-30")).toBeNull();
    expect(periodProblem("2026-09-02", "2026-09-01")).toMatch(
      /start on or before/,
    );
    expect(periodProblem("2026-08-01", "2026-09-30")).toMatch(
      /at most 31 days/,
    );
    expect(periodProblem("", "2026-09-30")).toBe("Pick both dates");
    expect(hoursSince(0, 3 * 3_600_000 + 59_000)).toBe(3);
    expect(hoursSince(10, 0)).toBe(0);
  });
});
