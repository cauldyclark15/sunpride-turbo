import { availabilitySamples } from "./tower-availability.js";
import { createHash } from "node:crypto";
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
  for (const row of d.rows("analytics_trade_inputs")) {
    const product = c.products.find((p) => p.id === row.product_id);
    if (!product) throw new Error("Missing sample source product");
    const units = Number(row.quantity_base) / Number(row.quantity_scale);
    expect(units).toBe(
      row.kind === "stock" ? 240 : Number(row.amount_centavos) / 12500,
    );
    expect(row.lineage.baseEncoding).toBe("scaled");
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

test("F-602 sample physical observations use governed ranges and owned completed calls, without changing calls", () => {
  const d = new Dataset("2026-10-20", 14),
    c = company(d, []),
    profile = c.agents[0];
  const make = (/** @type {number} */ i, /** @type {string} */ state) =>
    d.add("visit_executions", `availability-test-${i}`, {
      organization_id: "sunpride",
      outlet_id: c.stores[i].id,
      org_unit_id: c.stores[i].custodian_org_unit_id,
      assignee_profile_id: profile.id,
      service_date: "2026-10-20",
      state,
      last_server_time: "2026-10-20T03:00:00Z",
      checked_out_at: "2026-10-20T03:00:00Z",
    });
  const completed = make(0, "completed"),
    open = make(1, "in-progress"),
    external = make(2, "completed"),
    before = JSON.stringify(d.rows("visit_executions"));
  availabilitySamples(
    d,
    c,
    [completed, open, external],
    new Set([external.outlet_id]),
  );
  expect(JSON.stringify(d.rows("visit_executions"))).toBe(before);
  expect(d.rows("merchandising_audits")).toHaveLength(1);
  expect(d.rows("outlet_assortments")).toHaveLength(c.stores.length - 1);
  expect(
    d
      .rows("outlet_assortments")
      .some((r) => r.outlet_id === external.outlet_id),
  ).toBe(false);
  const audit = d.rows("merchandising_audits")[0],
    lines = d.rows("merchandising_availability");
  expect(audit.visit_id).toBe(completed.id);
  expect(lines).toHaveLength(4);
  expect(
    audit.required_available_count + audit.required_out_of_stock_count,
  ).toBe(lines.length);
  expect(
    lines.every((r) => r.note.includes("SAMPLE") && r.audit_id === audit.id),
  ).toBe(true);
  expect(audit.payload_hash).toBe(
    createHash("sha256")
      .update(
        JSON.stringify({
          sample: true,
          visitId: completed.id,
          lines: lines.map((r) => ({
            productId: r.product_id,
            status: r.status,
          })),
        }),
      )
      .digest("hex"),
  );
});
