// SP-0142: the carried-day trail reader must flag exactly the gaps the field app's cadence
// forbids, ignore off-duty time between End day and Start day, and keep its cadence in step
// with the Android app's PingCadence constants.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeTrail,
  CADENCE,
  formatReport,
  parseTrailInput,
  type TrailPing,
} from "./location-trail-gaps";

const T0 = Date.UTC(2026, 9, 14, 0, 0, 0); // 08:00 Manila
const MIN = 60_000;
// ~111 m per 0.001 degree of latitude.
const ping = (
  minute: number,
  trigger: string,
  north = 0,
  extra: Partial<TrailPing> = {},
): TrailPing => ({
  latitude: 14.55 + north * 0.001,
  longitude: 121.02,
  accuracyMeters: 15,
  speedMetersPerSecond: null,
  batteryPercent: 100 - Math.floor(minute / 30),
  mockLocation: false,
  trigger,
  recordedAt: T0 + minute * MIN,
  kind: "field",
  ...extra,
});

describe("analyzeTrail", () => {
  test("a day on cadence passes", () => {
    const pings = [
      ping(0, "start"),
      ping(5, "still"),
      ping(10, "still"),
      ping(11, "moving", 1),
      ping(12, "moving", 2),
      ping(13.9, "moving", 3), // 1.9 min: inside one fix interval of grace
      ping(19.5, "still", 3), // 5.6 min still: inside grace
      ping(20, "stop", 3),
    ];
    const report = analyzeTrail(pings);
    expect(report.gaps).toEqual([]);
    expect(report.largestGap).toBeNull();
    expect(report.segments).toHaveLength(1);
    expect(report.coveredMs).toBe(20 * MIN);
    expect(report.byTrigger).toEqual({
      start: 1,
      still: 3,
      moving: 3,
      stop: 1,
    });
    expect(report.battery).toEqual({ first: 100, last: 100 });
    expect(report.warnings).toEqual([]);
  });

  test("a still gap over 5 min plus grace is flagged", () => {
    const report = analyzeTrail([
      ping(0, "start"),
      ping(7, "still"),
      ping(8, "stop"),
    ]);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({ mode: "still", ms: 7 * MIN });
  });

  test("travelling across a gap uses the 1-minute cadence", () => {
    // 4 minutes and ~555 m with no ping: the phone was moving, so this is a gap even
    // though it is shorter than the still cadence.
    const report = analyzeTrail([
      ping(0, "start"),
      ping(4, "still", 5),
      ping(5, "stop", 5),
    ]);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]!.mode).toBe("moving");
    expect(report.gaps[0]!.distanceM).toBeGreaterThan(500);
    // Reported speed alone also makes it a moving gap.
    const fast = analyzeTrail([
      ping(0, "start", 0, { speedMetersPerSecond: 1.4 }),
      ping(3, "still"),
    ]);
    expect(fast.gaps[0]!.mode).toBe("moving");
  });

  test("drift within the fixes' accuracy is not travel", () => {
    const report = analyzeTrail([
      ping(0, "start", 0, { accuracyMeters: 120 }),
      ping(5, "still", 0.6, { accuracyMeters: 120 }), // ~67 m, under 120 m accuracy
    ]);
    expect(report.gaps).toEqual([]);
  });

  test("time between End day and the next Start day is off duty", () => {
    const report = analyzeTrail([
      ping(0, "start"),
      ping(4, "still"),
      ping(5, "stop"),
      ping(30, "still"), // stray ping while off duty: ignored
      ping(120, "start"),
      ping(124, "still"),
      ping(125, "stop"),
    ]);
    expect(report.gaps).toEqual([]);
    expect(report.segments).toHaveLength(2);
    expect(report.coveredMs).toBe(10 * MIN);
  });

  test("the largest gap is reported and grace is configurable", () => {
    const pings = [
      ping(0, "start"),
      ping(20, "still"),
      ping(60, "still"),
      ping(61, "stop"),
    ];
    const report = analyzeTrail(pings);
    expect(report.largestGap!.ms).toBe(40 * MIN);
    expect(report.gaps).toHaveLength(2);
    expect(analyzeTrail(pings, 60 * MIN).gaps).toEqual([]);
  });

  test("missing Start/End day and unordered input are handled with warnings", () => {
    const report = analyzeTrail([ping(5, "still"), ping(0, "still")]);
    expect(report.segments[0]!.start).toBe(T0);
    expect(report.warnings.join(" ")).toContain("no Start day ping");
    expect(report.warnings.join(" ")).toContain("no End day ping");
  });
});

describe("parseTrailInput", () => {
  const pings = [ping(0, "start"), ping(5, "still")];

  test("reads the trail query result", () => {
    const parsed = parseTrailInput(
      JSON.stringify({ name: "Sample", truncated: true, pings }, null, 2),
    );
    expect(parsed.pings).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  test("reads a bare array and drops truck pings", () => {
    const parsed = parseTrailInput(
      JSON.stringify([...pings, { ...ping(6, "moving"), kind: "van" }]),
    );
    expect(parsed.pings).toHaveLength(2);
  });

  test("reads JSON lines of raw rows filtered to one person and day", () => {
    const rows = [
      { ...pings[0], profileId: "p1", serviceDate: "2026-10-14" },
      { ...pings[1], profileId: "p2", serviceDate: "2026-10-14" },
      { ...pings[1], profileId: "p1", serviceDate: "2026-10-13" },
    ];
    const text = rows.map((r) => JSON.stringify(r)).join("\n");
    const parsed = parseTrailInput(text, {
      profileId: "p1",
      serviceDate: "2026-10-14",
    });
    expect(parsed.pings).toHaveLength(1);
    expect(parseTrailInput(JSON.stringify(rows[0])).pings).toHaveLength(1);
  });
});

test("the report names the verdict, shift and gaps in Manila time", () => {
  const text = formatReport(
    analyzeTrail([ping(0, "start"), ping(7, "still"), ping(8, "stop")]),
    false,
  );
  expect(text).toContain("FAIL: 1 gap(s)");
  expect(text).toContain("Shift 08:00:00–08:08:00 Manila");
  expect(text).toContain("08:00:00–08:07:00  7.0 min  still");
});

test("cadence matches the Android app's PingCadence", () => {
  const kotlin = readFileSync(
    join(
      import.meta.dir,
      "../apps/field-android/app/src/main/java/com/sunpride/field/location/Pings.kt",
    ),
    "utf8",
  );
  const constant = (name: string) => {
    const match = kotlin.match(
      new RegExp(`const val ${name} = ([0-9_.* ]+?)L?\\s*$`, "m"),
    );
    expect(match, name).not.toBeNull();
    return match![1]!
      .replaceAll("_", "")
      .split("*")
      .reduce(
        (product: number, factor: string) => product * Number(factor.trim()),
        1,
      );
  };
  expect(constant("MOVING_INTERVAL_MS")).toBe(CADENCE.movingIntervalMs);
  expect(constant("STILL_INTERVAL_MS")).toBe(CADENCE.stillIntervalMs);
  expect(constant("MOVING_DISTANCE_M")).toBe(CADENCE.movingDistanceM);
  expect(constant("MOVING_SPEED")).toBe(CADENCE.movingSpeedMps);
});
