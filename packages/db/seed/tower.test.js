import { test, expect } from "bun:test";
import { Dataset } from "./store.js";
import { company } from "./company.js";
import { towerSamples } from "./tower.js";

test("F-603 F-604 F-606 sample lineage context and evidence remain jsonb objects, not encoded strings", () => {
  const d = new Dataset("2026-10-20", 1),
    c = company(d, []);
  towerSamples(d, c);
  for (const [table, column] of [
    ["analytics_trade_inputs", "lineage"],
    ["analytics_outlet_context", "payload"],
    ["analytics_integrity_findings", "evidence"],
  ]) {
    expect(d.rows(table).length).toBeGreaterThan(0);
    for (const row of d.rows(table)) {
      expect(typeof row[column]).toBe("object");
      expect(Array.isArray(row[column])).toBe(false);
      expect(
        d.markers.some((m) => m.table_name === table && m.row_id === row.id),
      ).toBe(true);
    }
  }
  const score = d
    .rows("analytics_outlet_context")
    .find((r) => r.kind === "execution_score");
  if (!score) throw new Error("Missing sample execution score");
  expect(score.payload.label).toContain("Sample");
  expect(
    Object.values(score.payload.components).reduce(
      (/** @type {number} */ n, /** @type {any} */ v) => n + Number(v),
      0,
    ) / Object.keys(score.payload.components).length,
  ).toBe(score.payload.value);
});
