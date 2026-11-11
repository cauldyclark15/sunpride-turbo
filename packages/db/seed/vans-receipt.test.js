import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDemo } from "./index.js";
import { plusDays, todayManila } from "./store.js";
import { saleOverrideFacts } from "../../../apps/api/src/domains/fiscal/discounts.js";
import { startHarness } from "../../../apps/api/test/harness.js";

/** WEB-109: office void codes, refunds and SAP posting read a sale's retained `receipt.lines`.
 * @type {import('../../../apps/api/test/harness.js').Harness} */ let h;
beforeAll(async () => {
  h = await startHarness();
  await seedDemo(h.db, { days: 3, anchorDate: plusDays(todayManila(), 1) });
}, 180000);
afterAll(async () => {
  await h?.close();
});

test("sample van sales keep complete line facts on the receipt, matching their stored lines", async () => {
  const sales =
    await h.db`select s.id,s.outlet_id,s.total_centavos,s.receipt,(select count(*)::int from van_sale_lines l where l.sale_id=s.id) n from van_sales s`;
  expect(sales.length).toBeGreaterThan(0);
  for (const s of sales) {
    expect(Array.isArray(s.receipt.lines)).toBe(true);
    expect(s.receipt.lines.length).toBe(s.n);
    let sum = 0n;
    for (const l of s.receipt.lines) {
      for (const k of [
        "unitPriceMinor",
        "grossMinor",
        "discountMinor",
        "totalMinor",
        "quantityBase",
      ])
        expect(l[k]).toMatch(/^\d+$/);
      sum += BigInt(l.totalMinor);
    }
    expect(sum).toBe(BigInt(s.total_centavos));
    // The office void-code facts can be built from it (this threw a TypeError before).
    expect(() =>
      saleOverrideFacts(
        "void",
        s.id,
        s.outlet_id,
        s.receipt.lines,
        String(s.total_centavos),
      ),
    ).not.toThrow();
  }
}, 60000);
