import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaxPeriodSummary, type TaxSummaryData } from "./tax-period-summary";

const totals = {
  documents: 4,
  gross: "48000",
  vatable: "3482",
  vat: "418",
  vat_exempt: "32846",
  zero_rated: "10000",
  promo_discount: "0",
  privilege_discount: "4328",
  vat_removed: "1254",
  total_due: "42418",
};
const data: TaxSummaryData = {
  totals,
  days: [{ date: "2026-11-06", ...totals }],
  privilege: [
    {
      type: "senior",
      label: "Senior citizen",
      documents: 2,
      discount: "1392",
      vat_removed: "836",
      gross: "7800",
    },
    {
      type: "pwd",
      label: "PWD",
      documents: 1,
      discount: "2936",
      vat_removed: "418",
      gross: "16000",
    },
  ],
};

describe("TaxPeriodSummary", () => {
  it("shows each privilege discount and the removed VAT as their own lines", () => {
    const out = renderToStaticMarkup(createElement(TaxPeriodSummary, { data }));
    expect(out).toContain("Senior citizen discount");
    expect(out).toContain("PWD discount");
    expect(out).toContain("VAT removed on discounted sales");
    expect(out).toContain("₱13.92");
    expect(out).toContain("₱29.36");
    expect(out).toContain("₱12.54");
    expect(out).toContain("₱424.18");
    expect(out).toContain("VAT-exempt sales");
    expect(out).toContain("Zero-rated sales");
    expect(out).toContain("2 invoices");
    expect(out).toContain("1 invoice");
    expect(out).toContain("voided ones left out");
  });
  it("shows no discount lines for a period without any", () => {
    const out = renderToStaticMarkup(
      createElement(TaxPeriodSummary, {
        data: {
          ...data,
          privilege: [],
          totals: { ...totals, privilege_discount: "0", vat_removed: "0" },
        },
      }),
    );
    expect(out).not.toContain("Senior citizen discount");
    expect(out).not.toContain("VAT removed on discounted sales");
  });
});
