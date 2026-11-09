import { describe, expect, test } from "bun:test";
import { laneDbName, parseArgs } from "./lane-approve-device.js";

describe("lane-approve-device", () => {
  test("refuses any non-lane database", () => {
    expect(() => laneDbName("postgres://u:p@127.0.0.1:5432/sunpride")).toThrow(
      /Refusing/,
    );
    expect(() =>
      laneDbName("postgres://u:p@127.0.0.1:5432/sunpride_dev"),
    ).toThrow(/Refusing/);
    expect(() => laneDbName(undefined)).toThrow(/required/);
    expect(laneDbName("postgres://u:p@127.0.0.1:5432/sunpride_lane_kit")).toBe(
      "sunpride_lane_kit",
    );
  });
  test("parses arguments with safe defaults", () => {
    expect(parseArgs(["--email", "agent@sunpride.test"])).toEqual({
      app: "field-android",
      as: "admin@sunpride.test",
      email: "agent@sunpride.test",
    });
    expect(() => parseArgs([])).toThrow(/email/);
    expect(() => parseArgs(["--email", "a", "--app", "ios"])).toThrow(/app/);
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/Unknown/);
  });
});
