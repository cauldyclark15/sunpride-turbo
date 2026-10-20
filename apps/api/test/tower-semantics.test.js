import { test, expect } from "bun:test";
import { distributionFor } from "../src/domains/analytics/availability-adapter.js";
import { tradeRows } from "../src/domains/analytics/trade-planning.js";

test("F-602 stocking ND and turnover-weighted WD use the same measured universe, never buying reach", () => {
  const stores = [{ id: "a" }, { id: "b" }];
  const observations = new Map([
    ["a:p", { status: "available" }],
    ["b:p", { status: "out_of_stock" }],
  ]);
  const weights = new Map([
    ["a", 900],
    ["b", 100],
  ]);
  const result = distributionFor(stores, observations, weights, "p");
  expect(result.numericDistributionPct).toBe(50);
  expect(result.weightedDistributionPct).toBe(90);
  expect(result.unmeasured).toBe(0);
  observations.delete("b:p");
  const incomplete = distributionFor(stores, observations, weights, "p");
  expect(incomplete.numericDistributionPct).toBeNull();
  expect(incomplete.weightedDistributionPct).toBeNull();
  expect(incomplete.unmeasured).toBe(1);
  expect(incomplete.stockingObservedPct).toBe(50);
  observations.set("b:p", { status: "not_carried" });
  weights.delete("b");
  expect(
    distributionFor(stores, observations, weights, "p").weightedDistributionPct,
  ).toBeNull();
});

test("F-603 missing primary and secondary feeds stay unknown; declared stock alone is not zero offtake or infinite DOI", () => {
  const [r] = tradeRows(
    [
      {
        kind: "stock",
        quantity_base: 240,
        amount_centavos: null,
        distributor_key: "SAMPLE",
        distributor_name: "Sample distributor",
        product_id: "p",
        product_name: "Sample product",
        case_units: 24,
        case_known: true,
        quantity_scale: 1,
        service_date: "2026-10-20",
        source_received_at: "2026-10-20T12:00:00+08:00",
        source_type: "sample",
      },
    ],
    28,
  );
  expect(r.primaryCentavos).toBeNull();
  expect(r.secondaryCentavos).toBeNull();
  expect(r.primaryBase).toBeNull();
  expect(r.secondaryCases).toBeNull();
  expect(r.stockCases).toBe(10);
  expect(r.daysInventory).toBeNull();
});

test("F-603 F-607 normalizes source quantity scales and sums event-time cases per line across pack revisions", () => {
  const common = {
    distributor_key: "SAMPLE",
    distributor_name: "Sample",
    product_id: "p",
    product_name: "Sample product",
    canonical_quantity_scale: 1000,
    case_known: true,
    service_date: "2026-10-20",
    source_received_at: "2026-10-20T02:00:00Z",
    source_type: "sample",
    amount_centavos: 100,
  };
  const a = {
      ...common,
      quantity_base: 12000,
      quantity_scale: 1000,
      case_units: 12,
    },
    b = { ...common, quantity_base: 24, quantity_scale: 1, case_units: 24 };
  const facts = [
    { ...a, kind: "primary" },
    { ...b, kind: "primary" },
    { ...a, kind: "stock" },
    { ...b, kind: "stock" },
    { ...a, kind: "secondary" },
  ];
  const [row] = tradeRows(facts, 1);
  expect(row.primaryBase).toBe(36000);
  expect(row.primaryCases).toBe(2);
  expect(row.stockBase).toBe(36000);
  expect(row.stockCases).toBe(2);
  expect(row.daysInventory).toBe(3);
  expect(row.quantityScale).toBe(1000);
  const [unknown] = tradeRows(
    [
      { ...a, kind: "primary", case_known: false },
      { ...b, kind: "primary" },
    ],
    1,
  );
  expect(unknown.primaryCases).toBeNull();
  expect(unknown.primaryCentavos).toBe(200);
});
