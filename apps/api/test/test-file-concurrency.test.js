import { expect, test } from "bun:test";
import { testFileConcurrency } from "../scripts/test-file-concurrency.js";

test("F-025 retains the existing four-file default when no bound is requested", () => {
  expect(testFileConcurrency(undefined)).toBe(4);
});
test("F-025 native shared-engine proof can run one disposable file at a time", () => {
  expect(testFileConcurrency("1")).toBe(1);
});
test("F-025 explicit concurrency remains bounded by the original maximum", () => {
  for (const value of ["2", "3", "4"])
    expect(testFileConcurrency(value)).toBe(Number(value));
});
test("F-025 rejects malformed bounds rather than silently changing their values", () => {
  for (const value of ["", "0", "5", "1.5", "two", " 1", "01"])
    expect(() => testFileConcurrency(value)).toThrow("SP_TEST_CONCURRENCY");
});
