import { describe, expect, it } from "vitest";
import { launchBuildTargets } from "./editor-rules";

describe("F-216 editable launch build curve", () => {
  it("preserves the first milestone and every additional dated cumulative target", () => {
    expect(
      launchBuildTargets(
        "2026-11-01",
        10,
        "2026-11-08, 20\n\n2026-11-15, 30\r\n",
      ),
    ).toEqual([
      { date: "2026-11-01", outlets: 10 },
      { date: "2026-11-08", outlets: 20 },
      { date: "2026-11-15", outlets: 30 },
    ]);
    expect(launchBuildTargets("2026-11-01", 0, "")).toEqual([
      { date: "2026-11-01", outlets: 0 },
    ]);
  });
  it("refuses malformed rows rather than silently turning a target into zero", () => {
    for (const value of [
      "2026-11-08",
      "2026-11-08, -1",
      "2026-11-08, 1.5",
      "2026-11-08, 0x10",
      "2026-11-08, 3, 4",
    ])
      expect(() => launchBuildTargets("2026-11-01", 1, value)).toThrow();
  });
});
