import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CampaignEditor,
  FinanceClaimsWorkspace,
  readTpmTab,
  TradeMarketingWorkspace,
} from "./tpm-workspace";
import { centavos, peso, titleWords, words } from "./model";
const state = vi.hoisted(() => ({
  edit: true,
  search: "",
  tab: "Claims",
  values: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) =>
      react.useState(initial === "Claims" ? state.tab : initial),
  };
});
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.search),
  usePathname: () => "/trade-promotions",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    scroll?: boolean;
    children: React.ReactNode;
  }) => {
    const { scroll: _ignored, ...rest } = props as {
      scroll?: boolean;
    } & Record<string, unknown>;
    void _ignored;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
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
  state.search = "";
  state.tab = "Claims";
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
const trade = (search = "") => {
  state.search = search;
  return renderToStaticMarkup(createElement(TradeMarketingWorkspace));
};
it("F-501 campaigns are a plain list: Add campaign, row Edit, no KPI cards", () => {
  const html = trade();
  for (const text of ["Sample Cebu launch", "Add campaign", ">Edit<", "Oct"])
    expect(html).toContain(text);
  expect(html.indexOf('data-testid="list-add"')).toBeGreaterThan(-1);
  expect(html.indexOf('data-testid="list-add"')).toBeLessThan(
    html.indexOf('data-testid="list-table"'),
  );
  expect(html).toContain('href="/trade-promotions?campaign=hidden-version"');
  for (const gone of [
    "Committed trade spend",
    "Claims trend",
    "Create next version",
    "New campaign",
    "2026-10",
  ])
    expect(html).not.toContain(gone);
  expect(html).not.toContain("hidden-campaign</");
  expect(html).not.toContain("hidden-version</");
});
it("F-501 search, status chips and tabs come from the URL", () => {
  expect(trade("q=nothing-like-this")).toContain('data-testid="list-empty"');
  expect(trade("status=closed")).not.toContain("Sample Cebu launch");
  expect(trade("tab=overview")).toContain("Committed trade spend");
  expect(trade("tab=overview")).toContain("Prior 14 days");
  expect(trade("tab=spend")).toContain("Commit planned spend");
  expect(readTpmTab(new URLSearchParams("tab=bogus"))).toBe("campaigns");
});
it("F-501 Edit opens the campaign in a panel with Save", () => {
  const html = trade("campaign=hidden-version");
  expect(html).toContain("Edit campaign");
  expect(html).toContain("Save");
  expect(html).toContain('value="Sample Cebu launch"');
});
it("F-502 all eight authoring mechanics share one versioned engine and explicit net stacking", () => {
  const html = trade("tab=schemes");
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
  const list = trade();
  const finance = renderToStaticMarkup(createElement(FinanceClaimsWorkspace));
  expect(list).not.toContain("Add campaign");
  expect(list).not.toContain(">Edit<");
  expect(trade("campaign=hidden-version")).not.toContain("Edit campaign");
  expect(trade("tab=schemes")).not.toContain("Stack on remaining net value");
  expect(finance).not.toContain("Submit claim");
});
it("F-509 separates SAP write-off from recovery and exposes independent pending-resolution controls", () => {
  state.search = "tab=deductions";
  state.values.deductions = {
    rows: [
      {
        id: "case",
        accountKey: "Sample account",
        classification: "short_delivery",
        ownerName: "Sample owner",
        amountCentavos: 1000,
        recoveredCentavos: 600,
        writtenOffCentavos: 100,
        ageDays: 2,
        status: "open",
      },
    ],
  };
  const html = renderToStaticMarkup(createElement(FinanceClaimsWorkspace));
  expect(html).toContain("outstanding " + peso(300));
  expect(html).toContain("SAP write-off " + peso(100));
  for (const label of [
    "Change classification",
    "Request SAP recovery",
    "Request SAP write-off",
    "independent approver",
    "pending request does not reduce",
  ])
    expect(html).toContain(label);
  state.edit = false;
  expect(
    renderToStaticMarkup(createElement(FinanceClaimsWorkspace)),
  ).not.toContain("Request SAP write-off");
});
it("F-508 exposes versioned margin sources and weighted account/mechanic summaries", () => {
  state.values["roi-policies"] = {
    distributors: [
      { id: "sample-partner", name: "Sample partner", account_key: "SAMPLE" },
    ],
    rows: [],
  };
  state.values.roi = {
    rows: [],
    aggregates: [
      {
        dimension: "mechanic",
        key: "rebate",
        label: "Sample rebate",
        spendCentavos: 100,
        incrementalVolumeBase: 2,
        netRoiBps: 0,
        sample: true,
      },
    ],
  };
  const html = trade("tab=spend");
  for (const label of [
    "Save margin and cost source",
    "Sample partner",
    "Margin per base piece",
    "Missing data stays unknown",
    "Sample rebate",
    "net ROI 0.0%",
    "Clearly marked sample assumptions",
  ])
    expect(html).toContain(label);
  state.edit = false;
  expect(trade("tab=spend")).not.toContain("Save margin and cost source");
});
it("F-501 integer centavos distinguish unknown, zero and exact input values", () => {
  expect(centavos("12.35")).toBe(1235);
  expect(centavos("0")).toBe(0);
  expect(() => centavos("12.345")).toThrow();
  expect(() => centavos("-1")).toThrow();
  expect(peso(null)).toBe("Unknown");
  expect(peso(0)).not.toBe("Unknown");
});

it("WEB-142 claims read as words and the Finance tab lives in the URL", () => {
  state.search = "";
  const html = renderToStaticMarkup(createElement(FinanceClaimsWorkspace));
  expect(html).toContain("Needs evidence");
  expect(html).not.toContain("needs_evidence");
  expect(html).not.toMatch(/>needs evidence</);
  expect(html).toContain("Oct 1 – Oct 20, 2026");
  expect(html).not.toContain("2026-10-01");
  expect(html).toMatch(/aria-pressed="true"[^>]*>Claims</);
  state.search = "tab=liability";
  expect(renderToStaticMarkup(createElement(FinanceClaimsWorkspace))).toMatch(
    /aria-pressed="true"[^>]*>Liability</,
  );
});

it("WEB-142 metric and status words read as plain words with one capital", () => {
  expect(words("settlementVariance")).toBe("settlement variance");
  expect(titleWords("settlementVariance")).toBe("Settlement variance");
  expect(titleWords("needs_evidence")).toBe("Needs evidence");
});
it("WEB-161 the Add campaign form has Cancel next to Save", () => {
  const onCancel = vi.fn();
  const html = renderToStaticMarkup(
    createElement(CampaignEditor, { campaign: null, onCancel }),
  );
  expect(html).toContain(">Save</button>");
  expect(html).toContain(">Cancel</button>");
});
