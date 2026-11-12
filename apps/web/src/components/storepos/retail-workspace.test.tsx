import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  excelWorkbook,
  readWorkbook,
  RetailWorkspace,
  RetailOperations,
} from "./retail-workspace";

const state = vi.hoisted(() => ({ data: undefined as unknown, error: false }));
vi.mock("../../lib/api", () => ({
  useApi: () => ({ data: state.data, error: state.error }),
  useLive: () => {},
  mutate: vi.fn(),
}));
vi.mock("../cockpit/kit", () => ({
  Panel: ({
    title,
    question,
    children,
  }: {
    title: string;
    question: string;
    children: React.ReactNode;
  }) =>
    createElement(
      "section",
      null,
      createElement("h2", null, title),
      createElement("p", null, question),
      children,
    ),
}));
const html = (node: React.ReactNode) => renderToStaticMarkup(node);
beforeEach(() => {
  state.data = undefined;
  state.error = false;
});

describe("F-R08 retail owner reporting", () => {
  it("shows target, equal prior period, basket and next action without private identifiers", () => {
    state.data = {
      rows: [
        {
          id: "private-store",
          name: "Sample Cebu store",
          register: "Register one",
          registers: [{ id: "private-register", name: "Register one" }],
          sales: 4500,
          target: 10000,
          prior: 4000,
          basket: 4500,
          orders: 1,
          shrink: null,
          trend: [],
          nextAction: "Review the sales gap and replenish low stock",
        },
      ],
    };
    const view = html(createElement(RetailWorkspace));
    expect(view).toContain("Sample Cebu store");
    expect(view).toContain("₱45");
    expect(view).toContain("₱100");
    expect(view).toContain("₱40");
    expect(view).toContain("Prior equal period");
    expect(view).toContain("Approver only");
    expect(view).toContain("Review the sales gap and replenish low stock");
    expect(view).toContain("Excel XML export");
    expect(view).not.toContain("private-store");
    expect(view).not.toContain("private-register");
  });
  it("does not turn a refused read into an empty successful report", () => {
    state.error = true;
    const view = html(createElement(RetailWorkspace));
    expect(view).toContain("Could not load retail stores");
    expect(view).not.toContain("No store registers");
    expect(view).not.toContain("₱0");
  });
  it("keeps register reads visible but hides self-approval and blind discrepancy facts", () => {
    state.data = {
      register: {
        id: "private-register",
        name: "Register one",
        store: "Sample Cebu store",
        outletId: null,
      },
      reversals: [
        {
          id: "private-reversal",
          kind: "refund",
          reason: "Sample return",
          number: "SAMPLE-SI-01",
          status: "pending",
          canDecide: false,
        },
      ],
      deposits: [
        {
          id: "private-deposit",
          bank: "Sample bank",
          reference: "Sample slip",
          amount: "1000",
          status: "needs_review",
          expected: null,
          difference: null,
          canDecide: false,
        },
      ],
      replenishments: [],
      reads: [
        {
          id: "private-read",
          kind: "x",
          sequence: "12",
          snapshot: {
            date: "2026-10-21",
            salesCentavos: "11200",
            tenders: [{ label: "Cash", amount: "11200" }],
            vat: { vatMinor: "1200" },
            journal: [],
          },
        },
      ],
      locations: [],
      products: [],
      outlets: [],
      canManage: false,
      canPrepare: false,
      canApprove: false,
    };
    const view = html(
      createElement(RetailOperations, {
        registerId: "private-register",
        from: "2026-10-21",
        to: "2026-10-21",
      }),
    );
    expect(view).toContain("X read 12");
    expect(view).toContain("SAMPLE-SI-01");
    expect(view).toContain("Export journal for Excel");
    expect(view).toContain("A second person must decide");
    expect(view).not.toContain("Approve refund");
    expect(view).not.toContain("Expected");
    for (const id of [
      "private-register",
      "private-reversal",
      "private-deposit",
      "private-read",
    ])
      expect(view).not.toContain(id);
  });
  it("F-R06 exposes a private slip link only in the server-authorized partition", () => {
    state.data = {
      register: {
        id: "register",
        name: "Register one",
        store: "Sample store",
        outletId: null,
      },
      reversals: [],
      deposits: [
        {
          id: "opaque-slip",
          bank: "Sample bank",
          reference: "Sample slip",
          amount: "1000",
          status: "matched",
          canDecide: false,
          canViewPhoto: true,
        },
      ],
      replenishments: [],
      reads: [],
      locations: [],
      products: [],
      outlets: [],
      canManage: false,
      canPrepare: false,
      canApprove: false,
    };
    const view = html(
      createElement(RetailOperations, {
        registerId: "register",
        from: "2026-10-21",
        to: "2026-10-21",
      }),
    );
    expect(view).toContain("View deposit slip");
    expect(view).toContain(
      'href="/api/v1/storepos/deposits/opaque-slip/photo"',
    );
    expect(view.replace(/<[^>]*>/g, "")).not.toContain("opaque-slip");
  });
  it("F-R02 exact cents and complete journal/tender/VAT worksheets reconcile voids and refunds", () => {
    const snap = (amount: number) => ({
      cashier: "Sample cashier",
      lines: [
        {
          description: "Sample item",
          quantity: 1,
          uom: "PC",
          lineTotalCentavos: amount,
        },
      ],
    });
    const read = {
      id: "read",
      kind: "z",
      sequence: "1",
      snapshot: {
        date: "2026-10-21",
        salesCentavos: "123",
        tenders: [{ label: "Cash", amount: "123" }],
        vat: {
          vatMinor: "13",
          vatableSalesMinor: "110",
          vatExemptMinor: "0",
          zeroRatedMinor: "0",
        },
        journal: [
          { number: "SAMPLE-SI-1", status: "fulfilled", snapshot: snap(11200) },
          { number: "SAMPLE-SI-2", status: "voided", snapshot: snap(11200) },
          {
            number: "SAMPLE-CM-1",
            kind: "refund",
            original: "SAMPLE-SI-1",
            amount: "11200",
          },
          { number: "SAMPLE-SI-3", status: "fulfilled", snapshot: snap(123) },
        ],
      },
    };
    const xml = readWorkbook(read);
    expect(xml).toContain('ss:Name="Tenders"');
    expect(xml).toContain('ss:Name="VAT"');
    expect(xml).toContain('ss:Type="Number">0.13');
    const first = xml.split("</Worksheet>")[0] ?? "";
    const totals = [...first.matchAll(/<Row>(.*?)<\/Row>/g)]
      .slice(1)
      .map((m) => {
        const data = [...m[1]!.matchAll(/<Data[^>]*>(.*?)<\/Data>/g)];
        return Number(data.at(-1)?.[1]);
      });
    expect(totals).toEqual([112, 0, -112, 1.23]);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(123 / 100);
    state.data = {
      register: {
        id: "r",
        name: "Sample register",
        store: "Sample store",
        outletId: null,
      },
      reads: [read],
      reversals: [],
      deposits: [],
      replenishments: [],
      locations: [],
      products: [],
      outlets: [],
      canManage: false,
      canPrepare: false,
      canApprove: false,
    };
    expect(
      html(
        createElement(RetailOperations, {
          registerId: "r",
          from: "2026-10-21",
          to: "2026-10-21",
        }),
      ),
    ).toContain("VAT ₱0.13");
  });
  it("exports actual SpreadsheetML with typed amounts and literal, escaped user text", () => {
    const workbook = excelWorkbook(
      ["Store", "Sales PHP"],
      [["=SUM(A1) & <sample>", 112.5]],
    );
    expect(workbook).toContain(
      'xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
    );
    expect(workbook).toContain('ss:Type="Number">112.5');
    expect(workbook).toContain(
      'ss:Type="String">=SUM(A1) &amp; &lt;sample&gt;',
    );
    expect(workbook).not.toContain("ss:Formula");
  });
});

describe("WEB-044 store configuration opens on the saved values", () => {
  it("shows the saved daily target and cash tolerance, not the ₱50 sample", () => {
    state.data = {
      register: { id: "r", name: "Register one", store: "Colon", outletId: null },
      reversals: [],
      deposits: [],
      replenishments: [],
      reads: [],
      policy: {
        id: "p2",
        toleranceCentavos: "5500",
        loyaltyEnabled: true,
        earnPerCentavos: "20000",
        pointValueCentavos: "150",
        employeeDiscountBps: 1500,
      },
      dailyTargetCentavos: "550000",
      locations: [],
      products: [],
      outlets: [],
      canManage: true,
      canPrepare: false,
      canApprove: false,
    };
    const view = html(
      createElement(RetailOperations, {
        registerId: "r",
        from: "2026-11-12",
        to: "2026-11-12",
      }),
    );
    expect(view).toMatch(/aria-label="Daily target \(₱\)"[^>]*value="5500"/);
    expect(view).toMatch(/aria-label="Cash tolerance \(₱\)"[^>]*value="55"/);
    expect(view).toMatch(/aria-label="Employee discount \(%\)"[^>]*value="15"/);
    expect(view).toMatch(/aria-label="Spend per point earned \(₱\)"[^>]*value="200"/);
    expect(view).toMatch(/aria-label="Redemption value per point \(₱\)"[^>]*value="1.50"/);
  });
});
