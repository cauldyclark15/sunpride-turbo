import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({ useQuery: () => undefined }));

import { AdminMonthlyPackView } from "./admin-pack-month";

const pack = {
  month: "2026-09",
  sources: {
    allocations: "office" as const,
    priorities: "sample" as const,
    claims: "sample" as const,
    receivables: "sample" as const,
  },
  allocations: [
    {
      code: "ALLOC-1",
      programRef: "PA-9",
      programName: "Sardines promo",
      allocatedStores: 4,
      budgetMinor: 50_000_00,
      executedStores: 3,
      executedChecks: 3,
      notExecutedChecks: 1,
    },
  ],
  priorities: [
    {
      code: "P-1",
      docType: "sasr" as const,
      title: "Weekend activation",
      accountName: "Gaisano Mactan (sample)",
      ownerName: "ASM",
      dueDate: "2026-09-10",
      status: "pending" as const,
      submittedDate: null,
    },
    {
      code: "P-2",
      docType: "coa" as const,
      title: "Calendar of Activity",
      accountName: "Gaisano Mactan (sample)",
      ownerName: "ASM",
      dueDate: "2026-09-03",
      status: "approved" as const,
      submittedDate: "2026-09-02",
    },
  ],
  claims: [],
  receivables: [
    {
      code: "AR-1",
      customerCode: "KA-1",
      customerName: "Metro Ayala (sample)",
      asOfDate: "2026-09-01",
      termsDays: 30,
      currentMinor: 1_000_00,
      days1to30Minor: 500_00,
      days31to60Minor: 0,
      days61to90Minor: 0,
      over90Minor: 0,
      collectedMinor: 400_00,
      pendingReviewMinor: 100_00,
      customerFound: true,
    },
  ],
  truncated: {
    allocations: false,
    priorities: false,
    claims: false,
    receivables: true,
  },
};

const disabled = (html: string) =>
  html.match(/<button[^>]*disabled[^>]*>/g)?.length ?? 0;

describe("monthly admin pack view", () => {
  it("shows the four reports, the data source and fails closed when capped", () => {
    const html = renderToStaticMarkup(
      createElement(AdminMonthlyPackView, { pack, today: "2026-09-30" }),
    );
    expect(html).toContain("Programs utilization vs allocation");
    expect(html).toContain("Sardines promo");
    expect(html).toContain("75%");
    expect(html).toContain("Office records");
    expect(html).toContain("Sample data (made up for the beta");
    expect(html).toContain("Priorities");
    expect(html).toContain("1 overdue");
    expect(html).toContain("Pending · overdue");
    expect(html).toContain("Claims Summary (ADP)");
    expect(html).toContain("No distribution partner claims this month");
    expect(html).toContain("Account Receivables reckoning (KAS)");
    expect(html).toContain("Metro Ayala (sample)");
    expect(html).toContain("cannot be exported");
    // Claims: nothing to export; receivables: capped. Allocations and priorities export.
    expect(disabled(html)).toBe(2);
  });
});
