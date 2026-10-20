import { expect, test } from "bun:test";
import { suggestQuantities } from "../src/domains/van/load-suggestions.js";

test("F-102 three cycles adjust by today's class mix; open pre-sell demand is not counted twice", () => {
  const cycles = [10, 12, 14].map((n, i) => ({
    id: `cycle-${i}`,
    rows: [
      {
        productId: "sku",
        classification: "A",
        outletId: "store-a",
        quantityBase: String(n),
      },
      {
        productId: "sku",
        classification: "B",
        outletId: "store-b",
        quantityBase: "4",
      },
    ],
  }));
  const [r] = suggestQuantities({
    classMix: { A: 2, B: 1 },
    cycles,
    orders: [{ id: "open-order", productId: "sku", quantityBase: "35" }],
  });
  expect(r.forecastBase).toBe(String(((10 + 12 + 14) * 2 + 4 * 3) / 3));
  expect(r.suggestedBase).toBe("35");
  expect(r.orderIds).toEqual(["open-order"]);
  expect(r.cycles).toHaveLength(3);
});
test("F-102 absent history is explicit rather than fabricated and stable source IDs deduplicate the trace", () => {
  const [r] = suggestQuantities({
    classMix: {},
    cycles: [],
    orders: [
      { id: "one", productId: "sku", quantityBase: "3" },
      { id: "one", productId: "sku", quantityBase: "4" },
    ],
  });
  expect(r.forecastBase).toBe("0");
  expect(r.suggestedBase).toBe("7");
  expect(r.orderIds).toEqual(["one"]);
  expect(
    suggestQuantities({ classMix: { A: 5 }, cycles: [], orders: [] }),
  ).toEqual([]);
});
