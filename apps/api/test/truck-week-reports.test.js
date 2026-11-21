import { test, expect } from "bun:test";
import {
  cashierFacts,
  printReport,
  quantityText,
} from "../src/domains/truckweek/reports.js";

const week = {
  request_facts: {
    products: [
      {
        productId: "p",
        quantityScale: "1000",
        unitPriceMinor: "2500",
        priceSource: "sap",
      },
    ],
  },
};
const line = { productId: "p", servedBase: 80000, countedBase: 30000 };

test("SP-0227 cashier uses served less counted and scaled governed prices with exact rounding", () => {
  expect(cashierFacts(week, [line]).amountMinor).toBe("125000");
  expect(
    cashierFacts(week, [{ ...line, servedBase: 1, countedBase: 0 }])
      .amountMinor,
  ).toBe("3");
  expect(quantityText(1250, "1000")).toBe("1250 / 1000");
  expect(quantityText(null)).toBe("Not counted");
});

test("SP-0227 missing prices, missing counts and overage never certify a partial total", () => {
  expect(
    cashierFacts(week, [{ ...line, countedBase: null }]).amountMinor,
  ).toBeNull();
  expect(
    cashierFacts(week, [{ ...line, countedBase: 90000 }]).amountMinor,
  ).toBeNull();
  expect(
    cashierFacts(week, [
      line,
      { productId: "unpriced", servedBase: 1, countedBase: 0 },
    ]).amountMinor,
  ).toBeNull();
  const zero = {
    request_facts: {
      products: [{ productId: "p", quantityScale: "1", unitPriceMinor: "0" }],
    },
  };
  expect(cashierFacts(zero, [line]).amountMinor).toBe("0");
});

test("SP-0227 paper escapes stored text, discloses sample prices and refuses an unapproved request", () => {
  const d = {
    seller: "<script>alert(1)</script>",
    weekStart: "2026-11-16",
    status: "counted",
    requestFacts: { products: [], trips: [], plans: [] },
    lines: [
      {
        ...line,
        code: "<img>",
        name: "SAMPLE",
        quantityScale: "1000",
        uom: "KG",
        reasonName: "<svg>",
        priceSource: "sap_sample",
        unitPriceMinor: "2500",
        accountableBase: 50000,
        accountableMinor: "125000",
      },
    ],
    cashier: { amountMinor: "125000" },
  };
  const html = printReport(d, "cashier");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("PHP 1250.00");
  expect(html).toContain("SAMPLE PRICES");
  expect(html).toContain("does not move stock");
  expect(() => printReport({ ...d, requestFacts: null }, "request")).toThrow(
    "approved coverage plan",
  );
  expect(() => printReport(d, "invalid")).toThrow("Choose a stock report");
});
