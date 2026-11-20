import { expect, test } from "bun:test";
import {
  parseVisitFrequency,
  visitFrequencyLabel,
  visitFrequencySummary,
} from "../src/visit-frequency.js";

test("SP-0223 normalizes plain choices without losing exact monthly counts", () => {
  expect(parseVisitFrequency(" weekly ")).toEqual({
    label: "Weekly",
    days: 7,
    perMonth: null,
  });
  expect(parseVisitFrequency("Every   2 weeks")).toEqual({
    label: "Every 2 weeks",
    days: 14,
    perMonth: null,
  });
  expect(parseVisitFrequency("Monthly")).toEqual({
    label: "Monthly",
    days: 30,
    perMonth: null,
  });
  for (let n = 1; n <= 31; n++) {
    const value = parseVisitFrequency(`${n} times a month`);
    expect(value.perMonth).toBe(n);
    expect(visitFrequencyLabel(value.days, value.perMonth)).toBe(value.label);
  }
  expect(parseVisitFrequency("4 times a month")).not.toEqual(
    parseVisitFrequency("Weekly"),
  );
});
test("SP-0223 rejects invalid and fractional monthly counts", () => {
  for (const value of [
    null,
    undefined,
    {},
    [],
    4,
    "",
    "0 times a month",
    "32 times a month",
    "-1 times a month",
    "2.5 times a month",
    "monthly extra",
  ])
    expect(() => parseVisitFrequency(value)).toThrow();
});
test("SP-0223 preserves legacy day values and clearly labels unset and calendar cadences", () => {
  expect(visitFrequencyLabel(6, null)).toBe("Every 6 days");
  expect(visitFrequencySummary(null, null)).toBe("Not set");
  expect(visitFrequencySummary(7, 4)).toBe("4 visits/month");
  expect(visitFrequencySummary(7, null)).toBe("Weekly · 4–5 visits/month");
  expect(visitFrequencySummary(14, null)).toBe(
    "Every 2 weeks · 2–3 visits/month",
  );
  expect(visitFrequencySummary(30, null)).toBe("1 visit/month");
});
