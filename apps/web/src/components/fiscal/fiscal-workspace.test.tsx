import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
const state = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({ ...state, refetch: vi.fn() }),
  useLive: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../cockpit/kit", () => ({
  Panel: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", null, createElement("h2", null, title), children),
}));
import { FiscalWorkspace } from "./fiscal-workspace";
const fixture = () => ({
  units: [{ id: "branch", name: "Sample Cebu" }],
  vehicles: [],
  registrations: [
    {
      id: "registration",
      branch_name: "Sample Cebu",
      entity_name: "SAMPLE COMPANY",
      org_unit_id: "branch",
      document_type: "sales_invoice",
      status: "sample_not_filed",
    },
  ],
  series: [
    {
      id: "series",
      prefix: "SAMPLE-SI",
      branch_name: "Sample Cebu",
      document_type: "sales_invoice",
      first_serial: 1,
      last_serial: 100,
      next_allocate: 11,
    },
  ],
  allocations: [
    {
      id: "allocation",
      series_id: "series",
      first_serial: 1,
      last_serial: 10,
      next_issue: 3,
      accounted: 2,
      seller: "Sample Seller",
    },
  ],
  rules: [],
  documents: [],
  overrides: [] as Record<string, unknown>[],
  tenders: [
    {
      id: "maya",
      method: "maya",
      kind: "sale",
      amount_centavos: 10000,
      seller: "Sample Seller",
      trip_number: "Sample trip",
      facts: { reference: "MAYA-123" },
      decision: null,
    },
    {
      id: "card",
      method: "card",
      kind: "sale",
      amount_centavos: 20000,
      seller: "Sample Seller",
      trip_number: "Sample trip",
      facts: { reference: "AUTH-456" },
      decision: null,
    },
  ],
  tenderTotals: [
    {
      method: "maya",
      captured_centavos: "10000",
      awaiting_count: 1,
      refused_count: 0,
    },
    {
      method: "card",
      captured_centavos: "20000",
      awaiting_count: 1,
      refused_count: 0,
    },
  ],
  canManage: true,
  canDecide: true,
  truncated: false,
});
beforeEach(() => {
  state.data = fixture();
  state.error = undefined;
});
it("F-018 F-019 labels sample not filed and reconciles issued versus reserved numbers", () => {
  const html = renderToStaticMarkup(createElement(FiscalWorkspace));
  expect(html).toContain("Sample, not filed");
  expect(html).toContain("2 accounted");
  expect(html).toContain("8");
  expect(html).toContain("still reserved on handheld");
  expect(html).toContain("Add registration");
});
it("F-111 Money shows Maya and card separately and pending confirmation without claiming paid", () => {
  const html = renderToStaticMarkup(
    createElement(FiscalWorkspace, { moneyOnly: true }),
  );
  expect(html).toContain("Maya");
  expect(html).toContain("Card");
  expect(html).toContain("awaiting confirmation");
  expect(html).not.toContain("Add registration");
});
it("F-124 Decide exposes a second-person override with a reason and no setup controls", () => {
  const data = fixture();
  data.overrides = [
    {
      id: "request",
      kind: "discount",
      requester: "Sample Seller",
      amount_centavos: 2000,
      reason: "Sample concession",
      channel: "GT",
      requires_second: true,
      decision: null,
    },
  ];
  state.data = data;
  const html = renderToStaticMarkup(
    createElement(FiscalWorkspace, { decisionsOnly: true }),
  );
  expect(html).toContain("Second approval required");
  expect(html).toContain("Sample concession");
  expect(html).toContain("Decision reason");
  expect(html).not.toContain("Add registration");
});
it("F-111 tender policies are editable by branch and a Manila service date, without raw JSON", () => {
  state.data = {
    ...fixture(),
    tenderRules: [
      {
        id: "policy",
        branch_name: "Sample Cebu",
        method: "maya",
        label: "Branch Maya",
        enabled: true,
        effective_from: "2026-10-21T16:00:00Z",
        effective_to: null,
      },
    ],
  };
  const html = renderToStaticMarkup(createElement(FiscalWorkspace));
  expect(html).toContain("Branch Maya");
  expect(html).toContain("Schedule a tender policy");
  expect(html).toContain("Effective from (Manila service date)");
  expect(html).toContain("All branches in my scope");
  expect(html).not.toContain("textarea");
});
it("F-511 wildcard authority is named All channels and credit is not mislabeled as a tender", () => {
  state.data = {
    ...fixture(),
    rules: [
      {
        id: "rule",
        branch_name: "Sample Cebu",
        org_unit_id: "branch",
        role: "sales",
        channel: "*",
        kind: "credit",
        min_centavos: "1",
        max_centavos: "9223372036854775807",
        self_limit_centavos: "501",
      },
    ],
  };
  const html = renderToStaticMarkup(createElement(FiscalWorkspace));
  const text = html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
  expect(text).toContain(
    "Sample Cebu · sales · All channels · Credit: ₱0.01–₱92,233,720,368,547,758.07, own limit ₱5.01",
  );
});
it("F-111 full tender totals are not replaced by a capped payment-list subtotal", () => {
  state.data = {
    ...fixture(),
    truncated: true,
    tenderTotals: [
      {
        method: "maya",
        captured_centavos: "12345",
        awaiting_count: 501,
        refused_count: 2,
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(FiscalWorkspace, { moneyOnly: true }),
  );
  const text = html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
  expect(text).toContain("₱123.45");
  expect(text).toContain("All service dates");
  expect(text).toContain("Choose a service date");
  expect(html).not.toContain('aria-label="Chosen service date"');
  expect(text).toContain("501 awaiting confirmation");
  expect(text).toContain("2 refused");
});
it("F-019 partial register never presents a capped list as complete reconciliation", () => {
  state.data = { ...fixture(), truncated: true };
  const html = renderToStaticMarkup(createElement(FiscalWorkspace));
  expect(html).toContain("partial list");
});
