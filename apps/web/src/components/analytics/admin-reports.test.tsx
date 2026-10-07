import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

const at = Date.parse("2026-09-30T10:00:00+08:00");
const base = {
  employeeCode: null,
  positionLabel: "Route Distribution Salesman (RDS)",
  orgUnitId: "u1",
  sellingDay: true,
  callsTarget: 30,
  productiveTargetPct: 85,
  osaAudits: 1,
  collections: 0,
  collectedMinor: 0,
};
const ana = {
  ...base,
  profileId: "p1",
  name: "Ana",
  channel: "Route",
  manday: true,
  calls: 2,
  productiveCalls: 1,
  buyingAccounts: ["C-1", "C-2"],
  osaRequired: 8,
  osaAvailable: 6,
  collections: 1,
  collectedMinor: 1_500_00,
};
const kim = {
  ...base,
  profileId: "p2",
  name: "Kim",
  channel: "KAS",
  manday: true,
  calls: 2,
  productiveCalls: 2,
  // C-1 was also Ana's: the scope's UBA counts it once.
  buyingAccounts: ["C-1", "C-3"],
  osaRequired: 2,
  osaAvailable: 2,
};

const monthPack = {
  month: "2026-09",
  units: [],
  sources: {
    allocations: "sample",
    priorities: "sample",
    claims: "sample",
    receivables: "sample",
  },
  allocations: [],
  priorities: [],
  claims: [
    {
      code: "SAMPLE-CLAIM-1",
      source: "sample",
      partnerCode: "SAMPLE-ADP-01",
      partnerName: "Mandaue Distribution Partners (sample)",
      claimType: "rebate",
      claimRef: "CL-1",
      filedDate: "2026-09-02",
      claimedMinor: 100_00,
      approvedMinor: null,
      status: "filed",
    },
  ],
  receivables: [],
  truncated: {
    allocations: false,
    priorities: false,
    claims: false,
    receivables: false,
  },
};

vi.mock("convex/react", () => {
  const page = (n: number, rows: unknown[], programs: unknown[]) => ({
    serviceDate: "2026-09-30",
    page: n,
    pageCount: 2,
    pageSize: 1,
    peopleInScope: 2,
    truncated: false,
    units: [],
    channels: ["KAS", "Route"],
    rows,
    programs,
    collectionLines:
      n === 0
        ? [
            {
              id: "c1",
              profileId: "p1",
              personName: "Ana",
              customerCode: "C-1",
              customerName: "Aling Nena Store",
              outletCode: "O1",
              amountMinor: 1_500_00,
              currency: "PHP",
              method: "cash",
              reference: "OR-77",
              status: "recorded",
              at,
            },
          ]
        : [],
    collectionLinesTruncated: false,
    buyingAccountsTruncated: false,
  });
  return {
    useQuery: (ref: unknown) => {
      const name = getFunctionName(ref as never);
      if (name === "supervision/team:options")
        return {
          canDecide: true,
          units: [
            { id: "u1", code: "A", name: "Region A" },
            { id: "u2", code: "B", name: "Region B" },
          ],
          channels: ["KAS", "Route"],
        };
      if (name === "analytics/admin_pack:month") return monthPack;
      if (name === "analytics/admin_reports:day")
        return page(
          0,
          [ana],
          [
            {
              programRef: "PA-9",
              executed: 1,
              notExecuted: 1,
              notApplicable: 0,
            },
          ],
        );
      return undefined;
    },
    useQueries: (requests: Record<string, { args: { page: number } }>) =>
      Object.fromEntries(
        Object.entries(requests).map(([key, request]) => [
          key,
          page(
            request.args.page,
            [kim],
            [
              {
                programRef: "PA-9",
                executed: 2,
                notExecuted: 0,
                notApplicable: 1,
              },
            ],
          ),
        ]),
      ),
  };
});

import { AdminReports, AdminReportsView } from "./admin-reports";

describe("admin report pack", () => {
  it("adds every page into the four memo figures, programs and collections", () => {
    const html = renderToStaticMarkup(createElement(AdminReports));
    expect(html).toContain("Ana");
    expect(html).toContain("Kim");
    expect(html).toContain("Daily productive calls, UBA, OSA, mandays");
    // 3 of 4 calls productive; UBA C-1, C-2, C-3; OSA 8 of 10; 2 mandays.
    expect(html).toContain("3 of 4 calls · target 60");
    expect(html).toContain("75%");
    expect(html).toContain("Unique buying accounts");
    expect(html).toContain("8 of 10 required SKUs on shelf");
    expect(html).toContain("80%");
    expect(html).toContain("of 2 people");
    // Programs merged across pages: 3 executed, 1 not executed → 75%.
    expect(html).toContain("Programs utilization (day)");
    expect(html).toContain("PA-9");
    // Collections, then the monthly pack below the daily reports.
    expect(html).toContain("Aling Nena Store");
    expect(html).toContain("OR-77");
    expect(html).toContain("Monthly admin reports");
    expect(html).toContain("Claims Summary (ADP)");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Region B");
  });

  it("refuses to export a report whose source rows were capped", () => {
    const view = (flags: {
      truncated?: boolean;
      buyingAccountsTruncated?: boolean;
      collectionLinesTruncated?: boolean;
    }) =>
      renderToStaticMarkup(
        createElement(AdminReportsView, {
          serviceDate: "2026-09-30",
          rows: [ana] as never,
          programs: [],
          collectionLines: [],
          peopleInScope: 1,
          loading: false,
          truncated: flags.truncated ?? false,
          collectionLinesTruncated: flags.collectionLinesTruncated ?? false,
          buyingAccountsTruncated: flags.buyingAccountsTruncated,
        }),
      );
    const disabled = (html: string) =>
      html.match(/<button[^>]*disabled[^>]*>/g)?.length ?? 0;
    expect(disabled(view({}))).toBe(0);
    const uba = view({ buyingAccountsTruncated: true });
    expect(uba).toContain("UBA is incomplete and cannot be exported");
    expect(disabled(uba)).toBe(1);
    const lines = view({ collectionLinesTruncated: true });
    expect(lines).toContain(
      "cannot be\n              exported".replace(/\n\s+/, " "),
    );
    expect(disabled(lines)).toBe(1);
    expect(disabled(view({ truncated: true }))).toBe(3);
  });
});
