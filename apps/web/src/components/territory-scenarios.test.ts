import { describe, expect, it } from "vitest";
import { loadReading, potential } from "./territory-scenarios";

const w = (loadPct: number | null) => ({
  outlets: 1,
  potential: 0,
  potentialMissing: 0,
  visits: 4,
  serviceMinutes: 80,
  travelMinutes: 0,
  unpinned: 0,
  people: 1,
  capacityMinutes: 100,
  loadPct,
});
const t = (b: number | null, a: number | null) => ({
  territoryId: "t",
  name: "T",
  before: w(b),
  after: w(a),
  movedIn: 0,
  movedOut: 0,
  pins: [],
});

describe("F-224 territory rebalancing", () => {
  it("F-224 names over- and under-used territories after the move", () => {
    expect(loadReading(t(90, 110))).toBe(
      "90% → 110% of capacity. Over capacity.",
    );
    expect(loadReading(t(70, 50))).toBe("70% → 50% of capacity. Under-used.");
    expect(loadReading(t(70, 80))).toBe("70% → 80% of capacity.");
  });
  it("F-224 shows missing potential as not recorded, never as zero", () => {
    expect(potential(w(10))).toBe("0");
    expect(potential({ ...w(10), potentialMissing: 1 })).toBe("Not recorded");
    expect(
      potential({ ...w(10), outlets: 2, potential: 500, potentialMissing: 1 }),
    ).toBe("500");
  });
  it("F-224 never invents a load when nobody is assigned", () => {
    expect(loadReading(t(null, null))).toBe(
      "No salesperson assigned: capacity unknown.",
    );
  });
});
