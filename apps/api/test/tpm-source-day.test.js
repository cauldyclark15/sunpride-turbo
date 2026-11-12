import { expect, test } from "bun:test";
import { sourceDay } from "../src/domains/tpm/claim-source-options.js";

test("WEB-142 a claim source is labelled with a plain Manila day, never an ISO date", () => {
  // 2026-11-12 17:30 UTC is already Nov 13 in Manila.
  expect(sourceDay("2026-11-12T17:30:00Z")).toBe("Nov 13, 2026");
  expect(sourceDay(new Date("2026-11-13T01:00:00+08:00"))).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});
