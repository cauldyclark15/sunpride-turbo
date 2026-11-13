import { expect, test } from "bun:test";
import { addCallflowSamples } from "./callflow.js";
import { Dataset, plusDays, todayManila } from "./store.js";

// SP-0169 r6: a reset before noon Manila must not publish call-flow config in the future.
test("call-flow samples are effective no later than the seed run", () => {
  for (const anchor of [todayManila(), plusDays(todayManila(), 1)]) {
    const before = Date.now();
    const d = new Dataset(anchor, 7);
    addCallflowSamples(d);
    expect(Date.parse(d.effectiveNow)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(d.effectiveNow)).toBeLessThanOrEqual(Date.parse(d.noon));
    for (const t of ["call_flow_definitions", "call_flow_policies", "no_order_reasons"]) {
      const rows = d.tables.get(t) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(Date.parse(r.effective_from)).toBeLessThanOrEqual(Math.max(before, Date.now()));
    }
  }
});

test("a past anchor keeps the deterministic noon stamp", () => {
  const d = new Dataset("2026-01-05", 7);
  expect(d.effectiveNow).toBe(d.noon);
});
