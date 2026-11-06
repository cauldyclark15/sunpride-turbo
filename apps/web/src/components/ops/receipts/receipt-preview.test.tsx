import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptPreview } from "./receipt-preview";
import { fixtureReceipt, type ReceiptModel } from "./receipt-types";

const html = (m: ReceiptModel) =>
  renderToStaticMarkup(createElement(ReceiptPreview, { model: m }));

describe("ReceiptPreview", () => {
  it("shows every BIR field on the senior citizen sample (₱39 -> ₱27.86)", () => {
    const out = html(fixtureReceipt);
    for (const text of [
      "NOT FILED - SAMPLE",
      "SALES INVOICE",
      "SAMPLE-SI-000000042",
      "Series SAMPLE-SI-000000001 to SAMPLE-SI-000000500",
      "VAT REG TIN: 000-111-222-000",
      "MIN: 26011512345678901",
      "Serial no.: H10P758268A0123",
      "PTU no.: FP012026-07-0099999",
      "Accreditation no.: 082-123456789-000123",
      "Sold to: Sample Store Trading Inc.",
      "TIN: 123-456-789-000",
      "Address: 12 Colon St, Cebu City",
      "Less: VAT on senior citizen sale",
      "Senior citizen discount (20%)",
      "VATable sales",
      "VAT-exempt sales",
      "Zero-rated sales",
      "Name: Juana Dela Cruz",
      "ID no.: SC-2026-004411",
      "Signature:",
      "Change",
    ])
      expect(out, text).toContain(text);
    expect(out).toContain("₱27.86");
    expect(out).toContain("₱72.14");
    expect(out).toContain("₱4.18");
    expect(out).toContain("₱6.96");
    expect(out).toContain("ORIGINAL");
    expect(out).not.toContain("REPRINT");
  });

  it("marks a reprint, a void and missing legal details in plain words", () => {
    const reprint = html({
      ...fixtureReceipt,
      copy: { kind: "reprint", number: 2, label: "REPRINT - COPY 2" },
      status: "voided",
      banner: null,
      notFiled: false,
      footer: [],
      compliance: { complete: false, missing: ["ptuNumber", "minNumber"] },
    });
    expect(reprint).toContain("REPRINT - COPY 2");
    expect(reprint).toContain("VOID");
    expect(reprint).toContain("Permit to Use (PTU) number");
    expect(reprint).toContain("Machine ID (MIN)");
    expect(reprint).not.toContain("NOT FILED");
  });

  it("a plain sale has no discount holder block and no signature line", () => {
    const out = html({
      ...fixtureReceipt,
      privilege: null,
      discountLines: [],
      totals: {
        ...fixtureReceipt.totals,
        privilegeDiscountMinor: "0",
        vatRemovedMinor: "0",
      },
    });
    expect(out).not.toContain("Discount holder");
    expect(out).not.toContain("Signature:");
    expect(out).not.toContain("before the senior/PWD discount");
  });
});
