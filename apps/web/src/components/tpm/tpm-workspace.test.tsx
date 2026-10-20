import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  FinanceClaimsWorkspace,
  TradeMarketingWorkspace,
} from "./tpm-workspace";
import { centavos, peso } from "./model";
const state = vi.hoisted(() => ({
  edit: true,
  values: {} as Record<string, unknown>,
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[]) => ({ data: state.values[String(key[1])] }),
  useLive: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => state.edit }),
}));
beforeEach(() => {
  state.edit = true;
  state.values = {
    summary: {
      asOf: 1792454400000,
      budgetCentavos: 100000,
      committedCentavos: 25000,
      claimsAwaitingEvidence: 3,
      claimsAwaitingApproval: 1,
      rejectionBps: null,
      claimsCurrentCentavos: 25000,
      claimsPriorCentavos: 10000,
      trend: [
        { date: "2026-10-19", amountCentavos: 10000 },
        { date: "2026-10-20", amountCentavos: 15000 },
      ],
    },
    campaigns: {
      rows: [
        {
          id: "hidden-campaign",
          versionId: "hidden-version",
          version: 1,
          code: "SAMPLE",
          name: "Sample Cebu launch",
          mechanic: "Basket value off",
          status: "active",
          effectiveFrom: 1792368000000,
          effectiveTo: 1794960000000,
          scope: {},
          checklist: ["Display present"],
          budgetCentavos: 100000,
          committedCentavos: 25000,
          expectedVolumeBase: 1000,
          expectedRoiBps: 1500,
          source: "sample",
        },
      ],
    },
    options: { products: [], outlets: [], people: [], evidence: [] },
    roi: { rows: [] },
    claims: {
      rows: ["distributor", "modern_trade", "agency"].map((partyType, i) => ({
        id: "hidden-claim-" + i,
        reference: "SAMPLE-" + i,
        partyType,
        partyName: "Sample " + partyType,
        status: "needs_evidence",
        amountCentavos: 25000,
        periodFrom: "2026-10-01",
        periodTo: "2026-10-20",
        createdAt: 1792454400000,
      })),
    },
    policies: { types: [], approvals: [] },
    liabilities: { rows: [] },
    deductions: { rows: [] },
    incentives: { plans: [], statements: [] },
  };
});
it("F-501 owner workspace shows budget, prior period, trend, campaign drill and editable future versions", () => {
  const html = renderToStaticMarkup(createElement(TradeMarketingWorkspace));
  for (const text of [
    "Sample Cebu launch",
    "Committed trade spend",
    "Prior 14 days",
    "Claims trend",
    "Create next version",
    "New campaign",
    "Expected volume",
    "Commit planned spend",
    "Scheme authoring",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("hidden-campaign</");
  expect(html).not.toContain("hidden-version</");
});
it("F-502 all eight authoring mechanics share one versioned engine and explicit net stacking", () => {
  const html = renderToStaticMarkup(createElement(TradeMarketingWorkspace));
  for (const mechanic of [
    "basket",
    "slab",
    "combo",
    "bogo",
    "free goods",
    "percent off",
    "value off",
    "quantity off",
    "Stack on remaining net value",
  ])
    expect(html).toContain(mechanic);
});
it("F-505 F-507 one Finance queue shows all claimant types and SAP acknowledgement caveat", () => {
  const html = renderToStaticMarkup(createElement(FinanceClaimsWorkspace));
  for (const text of [
    "Sample distributor",
    "Sample modern_trade",
    "Sample agency",
    "Review claim",
    "Consolidated claim intake",
    "required evidence",
    "SAP acknowledgement",
    "Liability",
    "Deductions",
    "Incentives",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("hidden-claim-0</");
});
it("F-501 F-507 read-only viewers never receive master or claims write controls", () => {
  state.edit = false;
  const trade = renderToStaticMarkup(createElement(TradeMarketingWorkspace));
  const finance = renderToStaticMarkup(createElement(FinanceClaimsWorkspace));
  expect(trade).not.toContain("New campaign");
  expect(trade).not.toContain("Create next version");
  expect(trade).not.toContain("Scheme authoring");
  expect(finance).not.toContain("Submit claim");
});
it("F-501 integer centavos distinguish unknown, zero and exact input values", () => {
  expect(centavos("12.35")).toBe(1235);
  expect(centavos("0")).toBe(0);
  expect(() => centavos("12.345")).toThrow();
  expect(() => centavos("-1")).toThrow();
  expect(peso(null)).toBe("Unknown");
  expect(peso(0)).not.toBe("Unknown");
});
