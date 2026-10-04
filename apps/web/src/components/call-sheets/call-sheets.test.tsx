import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const week = (n: number, values: Record<string, number | null> = {}) => ({
  week: n,
  order: null,
  beginningInventory: null,
  take: null,
  delivered: null,
  offtake: null,
  endInventory: null,
  ...values,
});
const report = {
  outlet: { id: "o1", code: "PG-001", name: "Puregold Example" },
  localMonth: "2026-09",
  configured: true,
  revision: 2,
  header: {
    accountName: "Puregold Example",
    address: "12 Sample St",
    buyerName: "A. Buyer",
    contactNumber: null,
    accountInCharge: null,
    receivingInCharge: null,
    distributorName: "Example Distributor",
    distributorSchedule: "Tue/Fri",
    foc: null,
    pricing: null,
  },
  rows: [
    {
      productId: "p1",
      code: "SUNP-001",
      name: "Sunpride Hotdog 1kg",
      uom: "PC",
      barcode: "4800000000017",
      pricing: "₱189.00",
      onSheet: true,
      weeks: [week(1), week(2), week(3), week(4, { order: 24, offtake: 26 })],
    },
    {
      productId: "p2",
      code: "SLAP-200",
      name: "Slap Ham",
      uom: "PC",
      barcode: null,
      pricing: null,
      onSheet: false,
      weeks: [week(1), week(2), week(3), week(4, { take: 3 })],
    },
  ],
  capturedVisits: 2,
  lastCapturedAt: 1,
};
const detail = {
  outlet: {
    id: "o1",
    code: "PG-001",
    name: "Puregold Example",
    address: "12 Sample St",
    status: "active",
  },
  canEdit: true,
  account: {
    revision: 2,
    updatedAt: 1,
    header: report.header,
    lines: [
      {
        productId: "p1",
        code: "SUNP-001",
        name: "Sunpride Hotdog 1kg",
        uom: "PC",
        pricing: "₱189.00",
        active: true,
      },
      {
        productId: "p3",
        code: "HOL-OLD",
        name: "Retired",
        uom: "CAN",
        pricing: null,
        active: false,
      },
    ],
  },
};

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "callSheets/accounts:list")
      return {
        page: [
          {
            outletId: "o1",
            outletCode: "PG-001",
            outletName: "Puregold Example",
            accountName: "Puregold Example",
            lineCount: 2,
            revision: 2,
            updatedAt: 1,
          },
        ],
        isDone: true,
        continueCursor: "",
      };
    return undefined;
  },
}));

import {
  CallSheetEditor,
  CallSheetMonthView,
  CallSheetsWorkspace,
} from "./call-sheets-workspace";

describe("call sheet screens", () => {
  it("lists accounts in scope and asks for a selection", () => {
    const html = renderToStaticMarkup(<CallSheetsWorkspace />);
    expect(html).toContain("PG-001 · 2 products");
    expect(html).toContain("Outlet code");
    expect(html).toContain("Choose an account");
  });

  it("renders the Annex C grid with header, four weeks and six measures", () => {
    const html = renderToStaticMarkup(
      <CallSheetMonthView report={report as never} />,
    );
    expect(html).toContain("Call Sheet · Puregold Example");
    expect(html).toContain("September 2026 · PG-001 · 2 visits captured");
    expect(html).toContain("A. Buyer");
    expect(html).toContain("Tue/Fri");
    expect(html).toContain("Week 4");
    expect(html).toContain("(22–30)");
    expect(html.match(/>Off-take</g)).toHaveLength(4);
    expect(html).toContain("4800000000017");
    expect(html).toContain("(not on sheet)");
    expect(html).toContain(">24<");
    expect(html).toContain(">26<");
    expect(html).not.toContain("No call sheet set up");
  });

  it("says when an account has no sheet yet", () => {
    const html = renderToStaticMarkup(
      <CallSheetMonthView
        report={{ ...report, configured: false, rows: [] } as never}
      />,
    );
    expect(html).toContain("No call sheet set up for this account yet");
    expect(html).not.toContain("<table");
  });

  it("prefills the editor and flags inactive products", () => {
    const html = renderToStaticMarkup(
      <CallSheetEditor detail={detail as never} />,
    );
    expect(html).toContain('value="Puregold Example"');
    expect(html).toContain('value="Example Distributor"');
    expect(html).toContain("SUNP-001");
    expect(html).toContain('value="₱189.00"');
    expect(html).toContain("inactive, remove before saving");
    expect(html).toContain("Save call sheet");
  });
});
