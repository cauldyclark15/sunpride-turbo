import { describe, expect, it } from "vitest";
import {
  collectionsCsv,
  dailyPackCsv,
  mergePrograms,
  packTotals,
  programsCsv,
  programUtilizationPct,
  ratioPct,
  type AdminPackRow,
} from "./admin-reports";

const row = (over: Partial<AdminPackRow>): AdminPackRow => ({
  profileId: "p",
  name: "P",
  employeeCode: null,
  positionLabel: null,
  channel: "Route",
  sellingDay: true,
  manday: false,
  calls: 0,
  productiveCalls: 0,
  callsTarget: null,
  productiveTargetPct: null,
  buyingAccounts: [],
  osaAudits: 0,
  osaRequired: 0,
  osaAvailable: 0,
  collections: 0,
  collectedMinor: 0,
  ...over,
});

describe("admin report pack totals", () => {
  it("sums parts before dividing and counts each buying account once", () => {
    const totals = packTotals([
      row({
        manday: true,
        calls: 30,
        productiveCalls: 30,
        callsTarget: 30,
        buyingAccounts: ["C-1", "C-2"],
        osaRequired: 10,
        osaAvailable: 5,
      }),
      row({
        manday: true,
        calls: 5,
        productiveCalls: 0,
        callsTarget: 5,
        buyingAccounts: ["C-2"],
        osaRequired: 2,
        osaAvailable: 2,
      }),
      row({}),
    ]);
    expect(totals).toMatchObject({
      people: 3,
      mandays: 2,
      calls: 35,
      callsTarget: 35,
      uniqueBuyingAccounts: 2,
      osaRequired: 12,
      osaAvailable: 7,
    });
    // 30/35, not the average of 100% and 0%.
    expect(ratioPct(totals.productiveCalls, totals.calls)).toBe(85);
    expect(ratioPct(totals.osaAvailable, totals.osaRequired)).toBe(58);
    expect(ratioPct(1, 0)).toBeNull();
  });

  it("merges program tallies per reference and rates utilization on applicable stores", () => {
    const merged = mergePrograms([
      [{ programRef: "B", executed: 1, notExecuted: 1, notApplicable: 0 }],
      [
        { programRef: "B", executed: 2, notExecuted: 0, notApplicable: 4 },
        { programRef: "A", executed: 0, notExecuted: 0, notApplicable: 2 },
      ],
    ]);
    expect(merged).toEqual([
      { programRef: "A", executed: 0, notExecuted: 0, notApplicable: 2 },
      { programRef: "B", executed: 3, notExecuted: 1, notApplicable: 4 },
    ]);
    expect(programUtilizationPct(merged[1]!)).toBe(75);
    expect(programUtilizationPct(merged[0]!)).toBeNull();
  });
});

describe("admin report pack CSV", () => {
  it("writes the daily pack with acronyms, totals and guarded cells", () => {
    const text = dailyPackCsv("2026-09-30", [
      row({
        name: "=HYPERLINK(1)",
        employeeCode: "E-1",
        manday: true,
        calls: 2,
        productiveCalls: 1,
        buyingAccounts: ["C-1", "C-2"],
        osaRequired: 8,
        osaAvailable: 6,
        osaAudits: 1,
      }),
    ]);
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain("UBA,Unique Buying Account\r\n");
    expect(text).toContain("OSA,On Shelf Availability\r\n");
    expect(text).toContain("Mandays,1\r\n");
    expect(text).toContain("Productive %,50\r\n");
    expect(text).toContain("'=HYPERLINK(1)");
    expect(text).toContain(",2,C-1 C-2,1,8,6,75\r\n");
  });

  it("leaves allocation and AR balance blank with the reason", () => {
    const programs = programsCsv("2026-09-30", [
      { programRef: "PA-9", executed: 3, notExecuted: 1, notApplicable: 0 },
    ]);
    expect(programs).toContain("awaiting Sunpride's Promo Advice");
    expect(programs).toContain("PA-9,3,1,0,75,\r\n");
    const collections = collectionsCsv("2026-09-30", [
      {
        id: "c1",
        personName: "Ana",
        customerCode: "C-1",
        customerName: "Store, Inc.",
        outletCode: "O1",
        amountMinor: 1_500_50,
        currency: "PHP",
        method: "cash",
        reference: "OR-77",
        status: "pending_review",
        at: 0,
      },
    ]);
    expect(collections).toContain("Total collected,1500.50\r\n");
    expect(collections).toContain(
      'Ana,C-1,"Store, Inc.",O1,1500.50,PHP,cash,OR-77,Pending review\r\n',
    );
  });
});
