import { describe, expect, it } from "vitest";
import {
  callSheetCsv,
  manilaMonth,
  monthLabel,
  weekRange,
  type CallSheetReport,
} from "./call-sheet";

const empty = {
  order: null,
  beginningInventory: null,
  take: null,
  delivered: null,
  offtake: null,
  endInventory: null,
};
const sampleReport: CallSheetReport = {
  outlet: { code: "PG-001", name: "Puregold Example" },
  localMonth: "2026-09",
  configured: true,
  revision: 2,
  header: {
    accountName: "Puregold Example",
    address: "12 Sample St, Quezon City",
    buyerName: "A. Buyer",
    contactNumber: "0917 000 0000",
    accountInCharge: null,
    receivingInCharge: null,
    distributorName: '=HYPERLINK("x")',
    distributorSchedule: "Tue/Fri",
    foc: null,
    pricing: "SRP list",
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
      weeks: [
        { week: 1, ...empty },
        { week: 2, ...empty },
        { week: 3, ...empty },
        {
          week: 4,
          order: 24,
          beginningInventory: 10,
          take: null,
          delivered: 24,
          offtake: 26,
          endInventory: 8,
        },
      ],
    },
  ],
  capturedVisits: 1,
  lastCapturedAt: null,
};

describe("call sheet helpers", () => {
  it("names the Manila month and its four week columns", () => {
    expect(manilaMonth(Date.parse("2026-09-30T16:30:00Z"))).toBe("2026-10");
    expect(manilaMonth(Date.parse("2026-09-30T15:59:00Z"))).toBe("2026-09");
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect([1, 2, 3, 4].map((week) => weekRange("2026-02", week))).toEqual([
      "1–7",
      "8–14",
      "15–21",
      "22–28",
    ]);
    expect(weekRange("2026-10", 4)).toBe("22–31");
  });

  it("exports Annex C as a BOM CSV with 24 week cells and formula protection", () => {
    const csv = callSheetCsv(sampleReport);
    expect(
      csv.startsWith("\uFEFFCall Sheet (Annex C),September 2026\r\n"),
    ).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines).toContain("Buyer name,A. Buyer");
    expect(lines).toContain("Receiving in-charge,");
    expect(lines).toContain(`Distributor name,"'=HYPERLINK(""x"")"`);
    const columns = lines.find((line) => line.startsWith("Item barcode"))!;
    expect(columns.split(",")).toHaveLength(5 + 24);
    expect(columns).toContain("Week 4 Off-take");
    const row = lines[lines.length - 1]!.split(",");
    expect(row.slice(0, 5)).toEqual([
      "4800000000017",
      "Sunpride Hotdog 1kg",
      "SUNP-001",
      "PC",
      "₱189.00",
    ]);
    expect(row.slice(5, 23).every((value) => value === "")).toBe(true);
    expect(row.slice(23)).toEqual(["24", "10", "", "24", "26", "8"]);
  });
});
