import { expect, test } from "bun:test";
import { tradeRows } from "../src/domains/analytics/trade-planning.js";

/** @param {string} kind @param {boolean} complete */
const fact = (kind, complete) => ({
  id: kind,
  kind,
  distributor_key: "sample",
  distributor_name: "Sample partner",
  product_id: "sample-product",
  product_name: "Sample SKU",
  quantity_base: kind === "stock" ? 6 : 4,
  amount_centavos: kind === "stock" ? null : 800,
  service_date: "2026-10-21",
  source_received_at: "2026-10-21T00:00:00Z",
  source_quantity_scale: 1,
  canonical_quantity_scale: 1,
  case_known: false,
  feed_complete: complete,
});
test("F-603 F-607 incomplete canonical offtake never claims known DOI or a complete sales total", () => {
  const [row] = tradeRows([fact("secondary", false), fact("stock", true)], 1);
  expect(row.secondaryBase).toBeNull();
  expect(row.secondaryCentavos).toBeNull();
  expect(row.daysInventory).toBeNull();
});
test("F-603 F-607 complete canonical offtake retains the measured DOI", () => {
  const [row] = tradeRows([fact("secondary", true), fact("stock", true)], 1);
  expect(row.secondaryBase).toBe(4);
  expect(row.daysInventory).toBe(1.5);
});
