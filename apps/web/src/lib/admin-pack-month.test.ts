import { describe, expect, it } from "vitest";
import {
  allocationsCsv,
  allocationUsePct,
  claimsByPartner,
  claimsCsv,
  prioritiesCsv,
  priorityOverdue,
  receivablesCsv,
  remainingMinor,
  type ClaimRow,
  type ReceivableRow,
} from "./admin-pack-month";

const claim = (over: Partial<ClaimRow>): ClaimRow => ({
  code: "c",
  partnerCode: "ADP-1",
  partnerName: "Partner One",
  claimType: "rebate",
  claimRef: "CL-1",
  filedDate: "2026-09-02",
  claimedMinor: 100_00,
  approvedMinor: null,
  status: "filed",
  ...over,
});

const balance: ReceivableRow = {
  code: "AR-1",
  customerCode: "KA-1",
  customerName: "Store, Inc.",
  asOfDate: "2026-09-01",
  termsDays: 30,
  currentMinor: 1_000_00,
  days1to30Minor: 500_00,
  days31to60Minor: 250_00,
  days61to90Minor: 0,
  over90Minor: 50_00,
  collectedMinor: 300_00,
  pendingReviewMinor: 200_00,
  customerFound: true,
};

describe("monthly admin pack figures", () => {
  it("measures allocation use by stores executed", () => {
    const row = {
      code: "a",
      programRef: "PA-1",
      programName: "=cmd",
      allocatedStores: 8,
      budgetMinor: 1_000_00,
      executedStores: 3,
      executedChecks: 4,
      notExecutedChecks: 2,
    };
    expect(allocationUsePct(row)).toBe(37);
    expect(allocationUsePct({ ...row, allocatedStores: 0 })).toBeNull();
    const text = allocationsCsv("2026-09", [row], "sample");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain("Data source,Sample data");
    expect(text).toContain("COA,Calendar of Activity\r\n");
    expect(text).toContain("PA-1,'=cmd,8,1000.00,3,37,4,2\r\n");
  });

  it("flags documents still owed after their due date", () => {
    const row = {
      code: "p",
      docType: "da_contract" as const,
      title: "Contract",
      accountName: "Store",
      ownerName: "KAS",
      dueDate: "2026-09-10",
      status: "pending" as const,
      submittedDate: null,
    };
    expect(priorityOverdue(row, "2026-09-11")).toBe(true);
    expect(priorityOverdue(row, "2026-09-10")).toBe(false);
    expect(priorityOverdue({ ...row, status: "submitted" }, "2026-09-11")).toBe(
      false,
    );
    expect(prioritiesCsv("2026-09", [row], "2026-09-11", "office")).toContain(
      "D.A. contract,Contract,Store,KAS,2026-09-10,Pending,,Yes\r\n",
    );
  });

  it("summarizes claims per distribution partner", () => {
    const rows = [
      claim({ claimedMinor: 100_00 }),
      claim({ status: "validated", claimedMinor: 50_00 }),
      claim({ status: "approved", claimedMinor: 80_00, approvedMinor: 70_00 }),
      claim({ status: "paid", claimedMinor: 40_00, approvedMinor: 40_00 }),
      claim({ status: "rejected", claimedMinor: 30_00, approvedMinor: 0 }),
      claim({ partnerCode: "ADP-0", partnerName: "Partner Zero" }),
    ];
    expect(claimsByPartner(rows)).toEqual([
      expect.objectContaining({ partnerCode: "ADP-0", claims: 1 }),
      {
        partnerCode: "ADP-1",
        partnerName: "Partner One",
        claims: 5,
        claimedMinor: 300_00,
        approvedMinor: 110_00,
        paidMinor: 40_00,
        openMinor: 150_00,
        rejectedMinor: 30_00,
      },
    ]);
    expect(claimsCsv("2026-09", rows, "sample")).toContain(
      "ADP-1,Partner One,5,300.00,110.00,40.00,150.00,30.00\r\n",
    );
  });

  it("reckons receivables after recorded collections only", () => {
    expect(remainingMinor(balance)).toBe(1_500_00);
    expect(receivablesCsv("2026-09", [balance], "office")).toContain(
      'KA-1,"Store, Inc.",2026-09-01,30,1000.00,500.00,250.00,0.00,50.00,1800.00,300.00,200.00,1500.00\r\n',
    );
  });
});
