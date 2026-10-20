import { describe, expect, it } from "vitest";
import { crossedOn, nextStep, type DormancyCase } from "./dormancy-panel";
const base: DormancyCase = {
  id: "k",
  storeId: "s",
  name: "SAMPLE",
  code: "C",
  territory: "T",
  status: "open",
  lastPurchaseOn: "2026-07-23",
  missedCycles: 12,
  thresholdCycles: 3,
  cycleDays: 7,
  cycleSource: "outlet_cadence",
  detectedOn: "2026-10-21",
  recoveredOn: null,
  recoveryPurchaseOn: null,
  closedReason: null,
  nextVisit: null,
  policyVersion: 1,
  actions: [],
};
describe("F-210 dormancy owner panel", () => {
  it("F-210 dates dormancy at the threshold crossing, not at first detection", () => {
    expect(crossedOn(base)).toBe("2026-08-13");
  });
  it("F-210 next step moves from planning to follow-through to recovery", () => {
    expect(nextStep(base)).toBe("No visit is planned: plan a recovery visit.");
    expect(nextStep({ ...base, nextVisit: "2026-10-23" })).toContain(
      "2026-10-23",
    );
    expect(
      nextStep({
        ...base,
        actions: [
          {
            kind: "recovery_visit",
            note: "n",
            dueOn: "2026-10-22",
            actor: "A",
            at: 1,
          },
        ],
      }),
    ).toBe(
      "Recovery visit due 2026-10-22; close the case with a reason if it will not recover.",
    );
    expect(
      nextStep({
        ...base,
        status: "recovered",
        recoveryPurchaseOn: "2026-10-24",
      }),
    ).toBe("Recovered: bought again on 2026-10-24.");
  });
});
