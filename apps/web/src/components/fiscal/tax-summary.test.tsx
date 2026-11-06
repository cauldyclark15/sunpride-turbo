import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FiscalTaxSummary } from "./tax-summary";
it("F-109 distinguishes mixed invoice partitions, missing data and payment-only OR tax", () => {
  const tax = {
    vatableSalesMinor: "10100",
    vatMinor: "1200",
    vatExemptMinor: "3000",
    zeroRatedMinor: "5000",
  };
  const invoice = renderToStaticMarkup(
    <FiscalTaxSummary documentType="sales_invoice" tax={tax} />,
  );
  expect(invoice).toContain("VATable sales");
  expect(invoice).toContain("VAT exempt");
  expect(invoice).toContain("Zero rated");
  const collection = renderToStaticMarkup(
    <FiscalTaxSummary documentType="official_receipt" tax={tax} />,
  );
  expect(collection).toContain("No new invoice tax");
  expect(collection).not.toContain("<dl");
  const missing = renderToStaticMarkup(
    <FiscalTaxSummary documentType="sales_invoice" tax={null} />,
  );
  expect(missing).toContain("unavailable");
  expect(missing).not.toContain("0.00");
  const senior = renderToStaticMarkup(
    <FiscalTaxSummary
      documentType="sales_invoice"
      tax={{
        vatableSalesMinor: "0",
        vatMinor: "0",
        vatExemptMinor: "3482",
        zeroRatedMinor: "0",
        totalMinor: "2786",
        privilegeDiscountMinor: "696",
        vatRemovedMinor: "418",
        privilegeType: "senior",
      }}
    />,
  );
  expect(senior).toContain("Senior citizen discount");
  expect(senior).toContain("₱6.96");
  expect(senior).toContain("VAT removed on discounted sales");
  expect(senior).toContain("₱4.18");
  expect(senior).toContain("Amount paid");
  expect(senior).toContain("₱27.86");
  expect(invoice).not.toContain("discount");
});
