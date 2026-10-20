import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PjpSimulationView } from "./pjp-planner";
import { PjpAdherenceView } from "./pjp-adherence";
import type { PjpSimulation } from "./pjp-model";

const simulation: PjpSimulation = {
  simulationId: "fixture",
  hash: "fixture",
  result: {
    month: "2026-11",
    totalVisits: 4,
    outletCount: 1,
    potential: 1000,
    potentialIncomplete: false,
    serviceMinutes: 120,
    travelMinutes: 40,
    travelSource: "Provisional estimate",
    previous: { visits: 3, serviceMinutes: 90 },
    days: [
      {
        date: "2026-11-02",
        visits: 1,
        serviceMinutes: 30,
        travelMinutes: 10,
        totalMinutes: 40,
        capacityMinutes: 480,
      },
    ],
    overloadedDays: [],
    assignments: [
      {
        outletId: "not-a-display-value",
        outletName: "Sample Corner Store",
        classKey: "A",
        weekday: 1,
        phaseWeek: 0,
        visits: 4,
        potential: 1000,
        latitude: null,
        longitude: null,
      },
    ],
  },
};
describe("F-201 F-202 journey plan simulation", () => {
  it("shows targets/capacity, existing comparison, dates, next action, and honest travel provenance", () => {
    const html = renderToStaticMarkup(
      createElement(PjpSimulationView, { simulation }),
    );
    expect(html).toContain("Within daily capacity");
    expect(html).toContain("4 / 3");
    expect(html).toContain("40 / 480");
    expect(html).toContain("Sample Corner Store");
    expect(html).toContain("Provisional estimate");
    expect(html).not.toContain("not-a-display-value");
  });
  it("F-224 makes overload and missing map/potential facts explicit", () => {
    const data = {
      ...simulation,
      result: {
        ...simulation.result,
        potentialIncomplete: true,
        overloadedDays: [{}],
      },
    };
    const html = renderToStaticMarkup(
      createElement(PjpSimulationView, { simulation: data }),
    );
    expect(html).toContain("rebalance before publishing");
    expect(html).toContain("No verified pins");
    expect(html).toContain("incomplete");
  });
  it("F-206 never calls missing weeks a passed exit gate", () => {
    const html = renderToStaticMarkup(
      createElement(PjpAdherenceView, {
        data: {
          window: { from: "2026-09-21", to: "2026-10-18" },
          summary: { planned: 0, actual: 0, adherencePct: null },
          prior: { planned: 0, actual: 0, adherencePct: null },
          weeks: [],
          fourWeekGate: "insufficient_plan",
          rows: [],
          frequency: [],
        },
      }),
    );
    expect(html).toContain("not enough planned weeks");
    expect(html).toContain("above 85%");
    expect(html).not.toContain("met for this reading");
    expect(html).toContain("Journey plans");
  });
});
