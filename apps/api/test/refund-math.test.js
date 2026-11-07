import { test, expect } from "bun:test";
import {
  share,
  planRefund,
  refundTenders,
  needsSupervisor,
  saleLines,
  taxLinesFor,
} from "../src/domains/fiscal/refund-math.js";

/** IP-REFUND maths: pure, no database. The rules the phone repeats in pos/Refunds.kt. */
/** A store sale: 3 x vatable (1 x 100.00 each for 300.00 after a 10.00 promo), 1 x exempt 56.00, 1 free gift. */
const storeReceipt = () => ({
  totalMinor: "35600",
  lines: [
    {
      productId: "p1",
      description: "Nuggets",
      uom: "PC",
      quantity: 3,
      quantityBase: 3,
      unitPriceCentavos: 10000,
      lineTotalCentavos: 29000,
      discountCentavos: 1000,
      promoDiscountCentavos: 1000,
    },
    {
      productId: "p2",
      description: "Rice",
      uom: "PC",
      quantity: 1,
      quantityBase: 1,
      unitPriceCentavos: 5600,
      lineTotalCentavos: 5600,
      discountCentavos: 0,
    },
    {
      productId: "p3",
      description: "Free gift",
      uom: "PC",
      quantity: 1,
      quantityBase: 1,
      unitPriceCentavos: 0,
      lineTotalCentavos: 0,
      discountCentavos: 0,
    },
  ],
  tax: {
    // zero-gross lines are not in the snapshot, so 2 tax lines for 3 receipt lines
    lines: [
      {
        treatment: "vatable",
        rateBasisPoints: 1200,
        netMinor: "25893",
        vatMinor: "3107",
        totalMinor: "29000",
      },
      {
        treatment: "exempt",
        rateBasisPoints: 0,
        netMinor: "5600",
        vatMinor: "0",
        totalMinor: "5600",
      },
    ],
    vatableSalesMinor: "25893",
    vatMinor: "3107",
    vatExemptMinor: "5600",
    zeroRatedMinor: "0",
    totalMinor: "34600",
  },
});

test("cumulative shares: refunding a line in parts adds up to exactly the line, never a centavo more", () => {
  // 100.01 over 3 pieces cannot split evenly
  const parts = [1n, 1n, 1n].map((q, i) => share(10001n, BigInt(i), q, 3n));
  expect(parts).toEqual([3334n, 3333n, 3334n]);
  expect(parts.reduce((a, b) => a + b, 0n)).toBe(10001n);
  // all at once equals the sum of the parts
  expect(share(10001n, 0n, 3n, 3n)).toBe(10001n);
  expect(share(0n, 0n, 1n, 1n)).toBe(0n);
});

test("tax lines map to receipt lines even when the snapshot skipped a zero-gross gift line", () => {
  const r = storeReceipt();
  const lines = saleLines(r);
  const t = taxLinesFor(lines, r.tax);
  expect(t.map((x) => x?.treatment ?? null)).toEqual([
    "vatable",
    "exempt",
    null,
  ]);
});

test("a partial refund mirrors the sale: prorated total, VAT, exempt, promo and gross", () => {
  const plan = planRefund({
    receipt: storeReceipt(),
    picks: [{ lineIndex: 0, quantityBase: 1 }],
  });
  // 290.00 / 3 = 96.67 (cumulative half-up), VAT 31.07 / 3 = 10.36
  expect(plan.total).toBe(9667n);
  expect(plan.tax).toMatchObject({
    totalMinor: "9667",
    vatMinor: "1036",
    vatExemptMinor: "0",
    promoDiscountMinor: "333",
    grossMinor: "10000",
  });
  expect(plan.tax.lines).toHaveLength(1);
});

test("refunding everything in three goes gives back the sale's total and every tax bucket exactly", () => {
  const r = storeReceipt();
  const prior = new Map();
  const sum = { total: 0n, vat: 0n, vatable: 0n, exempt: 0n, promo: 0n };
  const picks = [
    [{ lineIndex: 0, quantityBase: 1 }],
    [
      { lineIndex: 0, quantityBase: 2 },
      { lineIndex: 2, quantityBase: 1 },
    ],
    [{ lineIndex: 1, quantityBase: 1 }],
  ];
  for (const p of picks) {
    const plan = planRefund({ receipt: r, prior, picks: p });
    for (const l of plan.lines)
      prior.set(l.lineIndex, (prior.get(l.lineIndex) ?? 0n) + l.quantityBase);
    sum.total += plan.total;
    sum.vat += BigInt(plan.tax.vatMinor);
    sum.vatable += BigInt(plan.tax.vatableSalesMinor);
    sum.exempt += BigInt(plan.tax.vatExemptMinor);
    sum.promo += BigInt(plan.tax.promoDiscountMinor);
  }
  expect(sum.total).toBe(34600n);
  expect(sum.vat).toBe(3107n);
  expect(sum.vatable).toBe(25893n);
  expect(sum.exempt).toBe(5600n);
  expect(sum.promo).toBe(1000n);
});

test("senior sale: privilege discount, VAT removed and VAT-exempt follow the share; buckets stay before the discount", () => {
  // 2 x PHP 39.00 vatable to a senior: payable 55.71, discount 13.93, VAT removed 8.36, exempt bucket 69.64
  const receipt = {
    totalMinor: "5571",
    lines: [
      {
        productId: "p1",
        description: "Nuggets",
        uom: "PC",
        quantity: 2,
        quantityBase: 2,
        unitPriceCentavos: 3900,
        lineTotalCentavos: 5571,
        discountCentavos: 2229,
        promoDiscountCentavos: 0,
        privilegeDiscountCentavos: 1393,
      },
    ],
    tax: {
      privilegeType: "senior",
      lines: [
        {
          treatment: "vatable",
          rateBasisPoints: 1200,
          netMinor: "6964",
          vatMinor: "0",
          totalMinor: "5571",
          privilegeType: "senior",
          privilegeDiscountMinor: "1393",
          vatRemovedMinor: "836",
        },
      ],
      vatableSalesMinor: "0",
      vatMinor: "0",
      vatExemptMinor: "6964",
      zeroRatedMinor: "0",
      totalMinor: "5571",
    },
  };
  const one = planRefund({
    receipt,
    picks: [{ lineIndex: 0, quantityBase: 1 }],
  });
  expect(one.total).toBe(2786n);
  // buckets = refund + privilege discount exactly (2786 + 697); the rest of the line then shows 3481, so both add up to 6964
  expect(one.tax).toMatchObject({
    vatExemptMinor: "3483",
    vatMinor: "0",
    privilegeDiscountMinor: "697",
    vatRemovedMinor: "418",
    privilegeType: "senior",
  });
  const rest = planRefund({
    receipt,
    prior: { 0: 1n },
    picks: [{ lineIndex: 0, quantityBase: 1 }],
  });
  expect(one.total + rest.total).toBe(5571n);
  expect(BigInt(one.tax.vatExemptMinor) + BigInt(rest.tax.vatExemptMinor)).toBe(
    6964n,
  );
  expect(
    BigInt(one.tax.privilegeDiscountMinor) +
      BigInt(rest.tax.privilegeDiscountMinor),
  ).toBe(1393n);
  expect(
    BigInt(one.tax.vatRemovedMinor) + BigInt(rest.tax.vatRemovedMinor),
  ).toBe(836n);
});

test("van receipts (grossMinor / totalMinor shape) go through the same maths", () => {
  const receipt = {
    totalMinor: "12525",
    lines: [
      {
        productId: "v1",
        name: "Sample",
        code: "S",
        quantityBase: "1",
        paidBase: "1",
        freeBase: "0",
        unitPriceMinor: "12525",
        grossMinor: "12525",
        discountMinor: "0",
        totalMinor: "12525",
      },
    ],
    tax: {
      lines: [
        {
          treatment: "vatable",
          netMinor: "11183",
          vatMinor: "1342",
          totalMinor: "12525",
        },
      ],
      totalMinor: "12525",
    },
  };
  const plan = planRefund({
    receipt,
    picks: [{ lineIndex: 0, quantityBase: 1 }],
  });
  expect(plan.total).toBe(12525n);
  expect(plan.tax).toMatchObject({
    vatMinor: "1342",
    vatableSalesMinor: "11183",
  });
});

test("a refund can never exceed what was sold and not yet refunded", () => {
  const r = storeReceipt();
  expect(() =>
    planRefund({ receipt: r, picks: [{ lineIndex: 0, quantityBase: 4 }] }),
  ).toThrow("more than was sold");
  expect(() =>
    planRefund({
      receipt: r,
      prior: { 0: 3n },
      picks: [{ lineIndex: 0, quantityBase: 1 }],
    }),
  ).toThrow("not yet refunded");
  expect(() => planRefund({ receipt: r, picks: [] })).toThrow();
  expect(() =>
    planRefund({ receipt: r, picks: [{ lineIndex: 9, quantityBase: 1 }] }),
  ).toThrow();
  expect(() =>
    planRefund({
      receipt: r,
      picks: [
        { lineIndex: 0, quantityBase: 1 },
        { lineIndex: 0, quantityBase: 1 },
      ],
    }),
  ).toThrow("once");
  expect(() =>
    planRefund({ receipt: r, picks: [{ lineIndex: 0, quantityBase: 0 }] }),
  ).toThrow();
  expect(() =>
    planRefund({
      receipt: r,
      picks: [{ lineIndex: 0, productId: "other", quantityBase: 1 }],
    }),
  ).toThrow("not on the original receipt");
});

test("the money goes back cash first, then the other methods, within what each method took", () => {
  const tenders = [
    { method: "gcash", label: "GCash", amountCentavos: "4000" },
    { method: "cash", label: "Cash", amountCentavos: "15000" },
  ];
  expect(refundTenders(tenders, new Map(), 3900n)).toEqual([
    { method: "cash", label: "Cash", amountCentavos: 3900n },
  ]);
  expect(refundTenders(tenders, { cash: 7800n }, 11200n)).toEqual([
    { method: "cash", label: "Cash", amountCentavos: 7200n },
    { method: "gcash", label: "GCash", amountCentavos: 4000n },
  ]);
  expect(() =>
    refundTenders(tenders, { cash: 15000n, gcash: 4000n }, 1n),
  ).toThrow();
});

test("a refund needs a supervisor only above the policy amount", () => {
  expect(needsSupervisor(50000n, "50000")).toBe(false);
  expect(needsSupervisor(50001n, 50000n)).toBe(true);
  // what the sale has already had refunded counts, so small refunds cannot be split around the amount
  expect(needsSupervisor(37575n, 50000n, 0n)).toBe(false);
  expect(needsSupervisor(37575n, 50000n, 37575n)).toBe(true);
  expect(needsSupervisor(1n, 50000n, 50000n)).toBe(true);
  expect(needsSupervisor(1n, 50000n, "49999")).toBe(false);
});

test("credit memo buckets add up exactly to the refund plus its privilege discount, over many partial refunds of SC/PWD and promo sales", () => {
  let seed = 123456789;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rnd = (/** @type {number} */ n) => Math.floor(next() * n);
  let off = 0;
  for (let it = 0; it < 3000; it++) {
    const lines = [], taxLines = [];
    let sum = 0;
    for (let i = 0, nl = 1 + rnd(4); i < nl; i++) {
      const q = 1 + rnd(12), unit = 100 + rnd(20000), gross = q * unit;
      const promo = rnd(3) === 0 ? rnd(Math.floor(gross / 4)) : 0;
      const priv = rnd(2) === 0, rate = [0, 1200][rnd(2)];
      const base = gross - promo;
      let vat = rate ? Math.round((base * rate) / (10000 + rate)) : 0;
      let payable = base, removed = 0, pd = 0;
      if (priv) {
        removed = vat;
        pd = Math.round((base - vat) * 0.2);
        payable = base - vat - pd;
        vat = 0;
      }
      lines.push({ productId: "p" + i, quantityBase: String(q), totalMinor: String(payable), grossMinor: String(gross), discountMinor: String(promo), name: "x", code: "c", uomCode: "PC", unitPriceMinor: String(unit) });
      taxLines.push({ netMinor: String(priv ? base - removed : base - vat), vatMinor: String(vat), vatRemovedMinor: String(removed), privilegeDiscountMinor: String(pd), treatment: rate ? "vatable" : "exempt", privilegeType: priv ? "senior" : null });
      sum += payable;
    }
    const receipt = { lines, tax: { lines: taxLines, vatMinor: "0", totalMinor: String(sum) }, totalMinor: String(sum) };
    const prior = new Map();
    const left = lines.map((l) => BigInt(l.quantityBase));
    for (let guard = 0; left.some((r) => r > 0n) && guard < 400; guard++) {
      /** @type {{lineIndex:number, quantityBase:bigint}[]} */ const picks = [];
      lines.forEach((_, i) => {
        if (left[i] > 0n && rnd(2)) picks.push({ lineIndex: i, quantityBase: 1n + BigInt(rnd(Number(left[i]))) });
      });
      if (!picks.length) continue;
      const plan = planRefund({ receipt, prior, picks });
      for (const o of plan.lines) {
        prior.set(o.lineIndex, (prior.get(o.lineIndex) ?? 0n) + o.quantityBase);
        left[o.lineIndex] -= o.quantityBase;
      }
      const t = plan.tax;
      const buckets = BigInt(t.vatableSalesMinor) + BigInt(t.vatMinor) + BigInt(t.vatExemptMinor) + BigInt(t.zeroRatedMinor);
      if (buckets !== plan.total + BigInt(t.privilegeDiscountMinor)) off++;
    }
  }
  expect(off).toBe(0);
});

test("the shared cases the phone also answers (fixtures/refund-math-cases.json) are what this maths gives", async () => {
  const { readFileSync } = await import("node:fs");
  const { cases, tenders, supervisor } = await import("./refund-math-fixture.js");
  const file = JSON.parse(
    readFileSync(new URL("./fixtures/refund-math-cases.json", import.meta.url), "utf8"),
  );
  // a change to the maths fails here until the fixture is regenerated (bun test/refund-math-fixture.js) AND the phone's
  // RefundMathTest passes against it
  expect(file.cases).toEqual(JSON.parse(JSON.stringify(cases)));
  expect(file.tenders).toEqual(JSON.parse(JSON.stringify(tenders)));
  expect(file.supervisor).toEqual(JSON.parse(JSON.stringify(supervisor)));
  expect(file.supervisor.length).toBeGreaterThanOrEqual(6);
  expect(file.cases.length).toBeGreaterThanOrEqual(10);
});

test("a refund approval code is the 8 digits the phone's RefundApprovalCodes also computes (literal shared with RefundMathTest.kt)", async () => {
  const { approvalCodeFor, approvalMessage } = await import("../src/domains/van/approvals.js");
  const key = "A".repeat(43);
  const facts = { receiptNumber: "R-1", totalMinor: "12525", reasonCode: "RF-DAMAGED", refundNumber: 2 };
  expect(approvalCodeFor(key, approvalMessage("refund", "trip-1", facts))).toBe("46253550");
  // every fact is bound
  for (const other of [{ refundNumber: 3 }, { totalMinor: "12526" }, { reasonCode: "RF-QUALITY" }, { receiptNumber: "R-2" }])
    expect(approvalCodeFor(key, approvalMessage("refund", "trip-1", { ...facts, ...other }))).not.toBe("46253550");
});
