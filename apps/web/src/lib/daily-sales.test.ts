import { describe, expect, it } from "vitest";
import { splitCsv } from "./csv";
import {
  callStatusText,
  dailySalesCsv,
  dailyTargetNote,
  manilaToday,
  percentText,
  pesoPlain,
  pesoText,
  remarksText,
  type DsrReport,
} from "./daily-sales";

const sampleReport: DsrReport = {
  serviceDate: "2026-09-28",
  localMonth: "2026-09",
  salesman: { name: "Ana Cruz", employeeCode: null, position: "Route Sales" },
  areaCovered: ["Route 1 Poblacion"],
  invoiceNumbers: ["SI-001", "SI-003"],
  sellingDay: true,
  sellingDaysInMonth: 26,
  targets: {
    daily: 384_615,
    dailySource: "derived_from_monthly",
    monthly: 10_000_000,
    sourceRef: "Sept 2026 allocation",
  },
  totals: {
    todaySales: 160_050,
    todayPct: 41,
    mtdSales: 340_050,
    mtdPct: 3,
    balanceToSell: 9_659_950,
  },
  calls: {
    planned: 3,
    calls: 2,
    productiveCalls: 1,
    productivePct: 50,
    dailyCallsTarget: 30,
    productiveCallTargetPct: 85,
  },
  customers: [
    {
      key: "outlet:o1",
      outletCode: "O1",
      customerCode: "C1",
      name: "Outlet 1",
      inRoutePlan: true,
      callStatus: "productive",
      matchedCodes: ["purchase_order", "collection"],
      todaySales: 140_050,
      mtdSales: 290_050,
      invoiceNumbers: ["SI-001"],
      reasonCode: null,
      remarks: ["Competitor display, at entrance"],
    },
    {
      key: "outlet:o2",
      outletCode: "O2",
      customerCode: null,
      name: "=Outlet 2",
      inRoutePlan: true,
      callStatus: "nonproductive",
      matchedCodes: [],
      todaySales: 0,
      mtdSales: 0,
      invoiceNumbers: [],
      reasonCode: "store_closed",
      remarks: [],
    },
    {
      key: "customer:C9",
      outletCode: null,
      customerCode: "C9",
      name: "Walk-in Nine",
      inRoutePlan: false,
      callStatus: null,
      matchedCodes: [],
      todaySales: 20_000,
      mtdSales: 20_000,
      invoiceNumbers: ["SI-003"],
      reasonCode: null,
      remarks: [],
    },
  ],
  categories: [
    {
      category: "Canned",
      todaySales: 90_050,
      todayQuantity: 1,
      mtdSales: 120_050,
      mtdQuantity: 4,
    },
    {
      category: "Mixes",
      todaySales: 0,
      todayQuantity: 0,
      mtdSales: 0,
      mtdQuantity: 0,
    },
    {
      category: "Frozen",
      todaySales: 50_000,
      todayQuantity: 1,
      mtdSales: 150_000,
      mtdQuantity: 3,
    },
  ],
  programs: [
    { programRef: "PROMO-SEPT", executed: 1, notExecuted: 0, notApplicable: 0 },
  ],
};

describe("daily sales report helpers", () => {
  it("formats centavos as pesos", () => {
    expect(pesoText(160_050)).toBe("₱1,600.50");
    expect(pesoText(null)).toBe("—");
    expect(pesoPlain(-10_000)).toBe("-100.00");
    expect(pesoPlain(null)).toBe("");
    expect(percentText(41)).toBe("41%");
    expect(percentText(null)).toBe("—");
  });

  it("uses the Manila calendar day", () => {
    expect(manilaToday(Date.parse("2026-09-27T16:30:00Z"))).toBe("2026-09-28");
    expect(manilaToday(Date.parse("2026-09-27T15:30:00Z"))).toBe("2026-09-27");
  });

  it("explains where today's target comes from", () => {
    expect(dailyTargetNote(sampleReport)).toBe(
      "Monthly target ÷ 26 selling days",
    );
    expect(
      dailyTargetNote({
        ...sampleReport,
        targets: { ...sampleReport.targets, dailySource: "set" },
      }),
    ).toBe("Daily target");
    expect(
      dailyTargetNote({
        ...sampleReport,
        sellingDay: false,
        targets: { ...sampleReport.targets, dailySource: null },
      }),
    ).toBe("Not a selling day");
    expect(
      dailyTargetNote({
        ...sampleReport,
        targets: { ...sampleReport.targets, dailySource: null },
      }),
    ).toBe("No target set");
  });

  it("builds the remarks and call columns", () => {
    expect(remarksText(sampleReport.customers[0]!)).toBe(
      "PO, Collection · Competitor display, at entrance",
    );
    expect(remarksText(sampleReport.customers[1]!)).toBe(
      "Reason: store closed",
    );
    expect(callStatusText("not_visited")).toBe("Not visited");
    expect(callStatusText(null)).toBe("No visit");
  });

  it("exports Annex B as a guarded CSV", () => {
    const csv = dailySalesCsv(sampleReport);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const rows = splitCsv(csv.trimEnd());
    expect(rows[0]).toEqual(["Daily Sales Report (Annex B)", "2026-09-28"]);
    expect(rows).toContainEqual(["SI number", "SI-001 SI-003"]);
    expect(rows).toContainEqual(["Today's sale", "1600.50"]);
    expect(rows).toContainEqual(["MTD balance to sell", "96599.50"]);
    expect(rows).toContainEqual([
      "O1",
      "C1",
      "Outlet 1",
      "Yes",
      "Productive",
      "1400.50",
      "2900.50",
      "SI-001",
      "PO, Collection · Competitor display, at entrance",
    ]);
    // Formula injection guard on a cell starting with "=".
    expect(rows.some((row) => row[2] === "'=Outlet 2")).toBe(true);
    expect(rows).toContainEqual(["Canned", "900.50", "1", "1200.50", "4"]);
    expect(rows).toContainEqual(["PROMO-SEPT", "1", "0", "0"]);
  });
});
