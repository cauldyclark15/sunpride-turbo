import { describe, expect, test } from "vitest";
import { deviceHistoryReason, deviceHistoryTitle } from "./devices-admin";

// FLD-013: the phone History tab showed "device.handover_completed" and "[object Object]".
describe("FLD-013 phone history reads in plain words", () => {
  test("every event has words, never the raw key", () => {
    expect(deviceHistoryTitle("device.handover_completed")).toBe(
      "Handover completed",
    );
    expect(deviceHistoryTitle("device.bound")).toBe("Signed in on phone");
    expect(deviceHistoryTitle("device.sample_registered")).toBe("Registered");
    expect(deviceHistoryTitle("people.devices.revoke")).toBe("Revoked");
    const unknown = deviceHistoryTitle("device.some_future_event");
    expect(unknown).toBe("Some future event");
    expect(unknown).not.toContain("device.");
  });
  test("only a reason code becomes words; objects never render", () => {
    expect(deviceHistoryReason("replacement")).toBe("replacement");
    expect(deviceHistoryReason("suspected_compromise")).toBe(
      "suspected compromise",
    );
    expect(deviceHistoryReason("[object Object]")).toBeNull();
    expect(deviceHistoryReason({ app: "field-android" })).toBeNull();
    expect(deviceHistoryReason('{"app":"field-android"}')).toBeNull();
    expect(deviceHistoryReason("bound")).toBeNull();
    expect(deviceHistoryReason(null)).toBeNull();
  });
});
