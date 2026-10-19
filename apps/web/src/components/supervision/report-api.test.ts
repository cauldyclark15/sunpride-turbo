import { describe, expect, it } from "vitest";
import { reportPath } from "./report-api";

describe("owned field-report routes", () => {
  it("uses the real VISITS location-decision route", () => {
    expect(reportPath("visits.location.decideLocationException")).toBe(
      "/api/v1/visits/location-exception/decide",
    );
  });
  it("keeps report reads and writes in FIELDREPORTS", () => {
    expect(reportPath("supervision.team.day")).toBe(
      "/api/v1/fieldreports/supervision/team/day",
    );
  });
});
