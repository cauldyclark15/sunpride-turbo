import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ReceiptList,
  ReprintPanel,
  journalWords,
  REPRINT_REASONS,
} from "./receipts-screen";
import {
  fixtureReceipt,
  type JournalEntry,
  type ReceiptRow,
} from "./receipt-types";

const rows: ReceiptRow[] = [
  {
    id: "a",
    saleId: "s1",
    sourceType: "store_sale",
    documentNumber: "SAMPLE-SI-000000042",
    documentType: "sales_invoice",
    issuedAt: "2026-11-06T02:15:00.000Z",
    totalDueMinor: "2786",
    buyerName: "Sample Store Trading Inc.",
    privilegeType: "senior",
    voided: false,
    reprints: 2,
  },
  {
    id: "b",
    saleId: "s2",
    sourceType: "van_sale",
    documentNumber: "SAMPLE-SI-000000041",
    documentType: "sales_invoice",
    issuedAt: "2026-11-06T01:00:00.000Z",
    totalDueMinor: "12525",
    buyerName: null,
    privilegeType: null,
    voided: true,
    reprints: 0,
  },
];
const journal: JournalEntry[] = [
  {
    seq: 1,
    entry_kind: "printed",
    copy_number: 1,
    reason: null,
    occurred_at: "2026-11-06T02:16:00.000Z",
    actor_name: "Ana Cashier",
    model_hash: "x",
    hash_basis: "print_model",
  },
  {
    seq: 2,
    entry_kind: "reprinted",
    copy_number: 1,
    reason: "Printer jammed",
    occurred_at: "2026-11-06T02:20:00.000Z",
    actor_name: "Ben Supervisor",
    model_hash: "x",
    hash_basis: "print_model",
  },
];
const noop = () => {};
const first = journal[0] as JournalEntry;

describe("ReceiptList", () => {
  it("lists receipts newest first with pesos, discount tag, void and reprint counts", () => {
    const out = renderToStaticMarkup(
      createElement(ReceiptList, {
        rows,
        selectedId: "a",
        onSelect: noop,
        query: "",
        onQuery: noop,
      }),
    );
    expect(out).toContain("Find a receipt");
    expect(out).toContain("SAMPLE-SI-000000042");
    expect(out).toContain("₱27.86");
    expect(out).toContain("Senior citizen discount");
    expect(out).toContain("Reprinted 2×");
    expect(out).toContain("Voided");
    expect(out).toContain("No buyer name");
    expect(out).toContain('aria-current="true"');
  });
  it("says so when nothing matches", () => {
    const out = renderToStaticMarkup(
      createElement(ReceiptList, {
        rows: [],
        selectedId: null,
        onSelect: noop,
        query: "zzz",
        onQuery: noop,
      }),
    );
    expect(out).toContain("No receipts yet for this search.");
  });
});

describe("ReprintPanel", () => {
  it("has one primary action, a plain reason list and the e-journal in words", () => {
    const out = renderToStaticMarkup(
      createElement(ReprintPanel, {
        model: fixtureReceipt,
        journal,
        busy: false,
        message: "",
        onReprint: noop,
      }),
    );
    expect(out).toContain("Reprint copy");
    for (const r of REPRINT_REASONS) expect(out).toContain(r);
    expect(out).toContain("Printed");
    expect(out).toContain("Reprinted (copy 1)");
    expect(out).toContain("Printer jammed");
    expect(out).toContain("Ben Supervisor");
    expect(out).not.toContain('disabled=""');
  });
  it("blocks reprint of a voided receipt", () => {
    const out = renderToStaticMarkup(
      createElement(ReprintPanel, {
        model: { ...fixtureReceipt, status: "voided" },
        journal: [],
        busy: false,
        message: "",
        onReprint: noop,
      }),
    );
    expect(out).toContain("This receipt was voided");
    expect(out).toContain('disabled=""');
    expect(out).toContain("Nothing printed or reprinted yet.");
  });
  it("words for each e-journal kind", () => {
    expect(journalWords({ ...first, entry_kind: "voided" })).toBe("Voided");
    expect(journalWords({ ...first, entry_kind: "spoiled" })).toBe("Spoiled");
  });
});
