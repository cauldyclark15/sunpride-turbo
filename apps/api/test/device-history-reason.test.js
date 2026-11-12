import { describe, expect, test } from "bun:test";
import { historyReason } from "../src/domains/org/devices.js";

// FLD-013: audit details reach the phone History tab only as a short reason code.
describe("FLD-013 device history reason", () => {
  test("reason codes pass; objects, JSON without a reason and [object Object] do not", () => {
    expect(historyReason("replacement")).toBe("replacement");
    expect(historyReason(JSON.stringify({ reason: "lost", app: "x" }))).toBe(
      "lost",
    );
    expect(historyReason("[object Object]")).toBeNull();
    expect(historyReason(JSON.stringify({ app: "field-android" }))).toBeNull();
    expect(historyReason(null)).toBeNull();
    expect(historyReason({ reason: "lost" })).toBeNull();
  });
});
