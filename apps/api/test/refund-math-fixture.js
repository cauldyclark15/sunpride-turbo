// Builds apps/api/test/fixtures/refund-math-cases.json: refund cases answered by the office maths (fiscal/refund-math.js).
// The phone's RefundMathTest.kt must give the same answers. Regenerate: bun test/refund-math-fixture.js
import { planRefund, refundTenders } from "../src/domains/fiscal/refund-math.js";

const store = {
  totalMinor: "35600",
  lines: [
    { productId: "p1", description: "Nuggets", uom: "PC", quantity: 3, quantityBase: 3, unitPriceCentavos: 10000, lineTotalCentavos: 29000, discountCentavos: 1000, promoDiscountCentavos: 1000 },
    { productId: "p2", description: "Rice", uom: "PC", quantity: 1, quantityBase: 1, unitPriceCentavos: 5600, lineTotalCentavos: 5600, discountCentavos: 0 },
    { productId: "p3", description: "Free gift", uom: "PC", quantity: 1, quantityBase: 1, unitPriceCentavos: 0, lineTotalCentavos: 0, discountCentavos: 0 },
  ],
  tax: {
    lines: [
      { treatment: "vatable", rateBasisPoints: 1200, netMinor: "25893", vatMinor: "3107", totalMinor: "29000" },
      { treatment: "exempt", rateBasisPoints: 0, netMinor: "5600", vatMinor: "0", totalMinor: "5600" },
    ],
    vatableSalesMinor: "25893", vatMinor: "3107", vatExemptMinor: "5600", zeroRatedMinor: "0", totalMinor: "34600",
  },
};
// A van sale: the van's own line shape (totalMinor, name, uomCode), one tax line per receipt line.
const van = {
  totalMinor: "37575",
  lines: [
    { productId: "v1", name: "Frozen nuggets 1kg", uomCode: "PC", quantityBase: 3, unitPriceMinor: "12525", totalMinor: "37575", grossMinor: "37575", discountMinor: "0" },
  ],
  tax: {
    lines: [{ treatment: "vatable", rateBasisPoints: 1200, netMinor: "33549", vatMinor: "4026", totalMinor: "37575" }],
    vatableSalesMinor: "33549", vatMinor: "4026", vatExemptMinor: "0", zeroRatedMinor: "0", totalMinor: "37575",
  },
};
// A senior-citizen sale: VAT removed and 20% off on one vatable line; the buckets show the amounts BEFORE the discount.
const senior = {
  totalMinor: "8929",
  lines: [
    { productId: "s1", description: "Biscuits", uom: "PC", quantity: 4, quantityBase: 4, unitPriceCentavos: 3125, lineTotalCentavos: 8929, discountCentavos: 3571 },
  ],
  tax: {
    privilegeType: "senior_citizen",
    lines: [
      { treatment: "vatable", privilegeType: "senior_citizen", rateBasisPoints: 1200, netMinor: "11161", vatMinor: "1339", totalMinor: "8929", privilegeDiscountMinor: "2232", vatRemovedMinor: "1339" },
    ],
    vatableSalesMinor: "0", vatMinor: "0", vatExemptMinor: "11161", zeroRatedMinor: "0", totalMinor: "8929", privilegeDiscountMinor: "2232", vatRemovedMinor: "1339",
  },
};
// A very old receipt: no tax lines, the sale's own mix is used.
const old = {
  totalMinor: "20000",
  lines: [
    { productId: "o1", description: "Soda", uom: "PC", quantity: 2, quantityBase: 2, lineTotalCentavos: 10000, discountCentavos: 0 },
    { productId: "o2", description: "Chips", uom: "PC", quantity: 5, quantityBase: 5, lineTotalCentavos: 10000, discountCentavos: 0 },
  ],
  tax: { vatableSalesMinor: "17857", vatMinor: "2143", vatExemptMinor: "0", zeroRatedMinor: "0", totalMinor: "20000" },
};

const cases = [
  ["store: one piece of a promo line", store, {}, { 0: 1 }],
  ["store: two pieces of a line, then the rest of it", store, { 0: 1 }, { 0: 2 }],
  ["store: the last piece after two single refunds (cumulative rounding)", store, { 0: 2 }, { 0: 1 }],
  ["store: exempt line and the free gift together", store, {}, { 1: 1, 2: 1 }],
  ["store: everything at once", store, {}, { 0: 3, 1: 1, 2: 1 }],
  ["van: one of three pieces", van, {}, { 0: 1 }],
  ["van: the last piece after two refunds", van, { 0: 2 }, { 0: 1 }],
  ["senior: one piece mirrors the privilege discount and VAT removal", senior, {}, { 0: 1 }],
  ["senior: the last three pieces after one", senior, { 0: 1 }, { 0: 3 }],
  ["old receipt without tax lines: sale mix", old, {}, { 0: 1, 1: 2 }],
].map(([name, receipt, prior, picks]) => {
  const plan = planRefund({
    receipt,
    prior: new Map(Object.entries(prior).map(([k, v]) => [Number(k), BigInt(v)])),
    picks: Object.entries(picks).map(([k, v]) => ({ lineIndex: Number(k), quantityBase: BigInt(v) })),
  });
  return {
    name, receipt, prior, picks,
    expected: {
      total: String(plan.total),
      vatableSalesMinor: plan.tax.vatableSalesMinor,
      vatMinor: plan.tax.vatMinor,
      vatExemptMinor: plan.tax.vatExemptMinor,
      zeroRatedMinor: plan.tax.zeroRatedMinor,
      privilegeDiscountMinor: plan.tax.privilegeDiscountMinor,
      lines: plan.lines.map((l) => ({
        lineIndex: l.lineIndex, amount: String(l.amountCentavos), vat: String(l.vatCentavos), bucket: l.bucket,
        gross: String(l.grossCentavos), promo: String(l.promoCentavos), privilege: String(l.privilegeDiscountCentavos),
        removed: String(l.vatRemovedCentavos), remaining: String(l.remainingBase),
      })),
    },
  };
});
const tenders = [
  { name: "cash only", tenders: [{ method: "cash", label: "Cash", amountCentavos: "10000" }], refunded: {}, total: "4000" },
  { name: "cash goes first, the rest from the card", tenders: [{ method: "card", label: "Card", amountCentavos: "5000" }, { method: "cash", label: "Cash", amountCentavos: "3000" }], refunded: {}, total: "6000" },
  { name: "earlier refunds used up the cash", tenders: [{ method: "cash", label: "Cash", amountCentavos: "3000" }, { method: "card", label: "Card", amountCentavos: "5000" }], refunded: { cash: "3000", card: "1000" }, total: "2500" },
].map((t) => {
  return { ...t, expected: refundTenders(t.tenders, new Map(Object.entries(t.refunded).map(([k, v]) => [k, BigInt(v)])), BigInt(t.total)).map((x) => ({ method: x.method, amount: String(x.amountCentavos) })) };
});
export { cases, tenders };

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  const out = new URL("./fixtures/refund-math-cases.json", import.meta.url);
  writeFileSync(out, JSON.stringify({ source: "apps/api/test/refund-math-fixture.js (office maths: fiscal/refund-math.js)", cases, tenders }, null, 2) + "\n");
  console.log("wrote", cases.length, "cases", tenders.length, "tender cases");
}
