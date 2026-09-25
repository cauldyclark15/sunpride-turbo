import { describe, expect, it } from "vitest";
import {
  coordinateKey,
  DEFAULT_SEVERITIES,
  severityFor,
} from "./exception_policy";
describe("provisional exception policy", () => {
  it("keeps unconfirmed route and GPS requirements advisory, configurable without weakening blockers", () => {
    expect(DEFAULT_SEVERITIES.territory_only).toBe("advisory");
    expect(DEFAULT_SEVERITIES.missing_gps).toBe("advisory");
    expect(DEFAULT_SEVERITIES.duplicate_location).toBe("advisory");
    expect(DEFAULT_SEVERITIES.inactive_customer).toBe("blocking");
    expect(severityFor("missing_gps", { missing_gps: "blocking" })).toBe(
      "blocking",
    );
  });
  it("detects same coordinates at documented five-decimal precision", () => {
    expect(coordinateKey(14.600001, 121.000001)).toBe(
      coordinateKey(14.600002, 121.000002),
    );
    expect(coordinateKey(14.6001, 121)).not.toBe(coordinateKey(14.6002, 121));
  });
});
