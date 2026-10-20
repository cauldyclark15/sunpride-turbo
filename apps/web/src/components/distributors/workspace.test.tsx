import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { DistributorWorkspace } from "./workspace";
import { Ordering, Stock } from "./commercial";
import type { Health, Workspace } from "./types";
const state = vi.hoisted(() => ({
  role: "distributor",
  grants: ["read", "stock"],
  calls: [] as string[],
  values: {} as Record<string, unknown>,
}));
vi.mock("../../lib/auth/session", () => ({
  useSession: () => ({
    profile: {
      role: state.role,
      orgUnitId: "private-area",
      name: "Partner person",
    },
  }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[] | null, path: string) => {
    if (key) state.calls.push(path);
    return {
      data: key
        ? state.values[key.length === 2 ? "list" : String(key[2])]
        : undefined,
      status: "success",
    };
  },
  mutate: vi.fn(),
  useLive: vi.fn(),
}));
let workspace: Workspace;
beforeEach(() => {
  state.role = "distributor";
  state.grants = ["read", "stock"];
  state.calls = [];
  const partner = {
    id: "private-partner-id",
    code: "PARTNER",
    name: "Sample Harbour",
    status: "accredited",
    source: "sample",
    grants: state.grants,
  };
  workspace = {
    distributor: { ...partner, sapCustomerCode: "MOCK-001" },
    application: null,
    terms: { paymentTerms: "Sample net 30 days", deliveryLeadDays: 2 },
    catalog: [
      {
        productId: "private-product-id",
        code: "FOOD",
        name: "Sample food",
        uom: "CS",
        unitsPerUom: 24,
        priceCentavos: 24000,
        availableBase: 2400,
      },
    ],
    outlets: [],
    locations: [
      {
        id: "private-location-id",
        code: "DEPOT",
        name: "Sample depot",
        kind: "warehouse",
      },
    ],
    documents: [],
    documentsTruncated: false,
    users: [],
    usersTruncated: false,
    policy: {
      doiWindowDays: 28,
      stockFreshDays: 1,
      nearExpiryDays: 30,
      understockDays: 7,
      overstockDays: 45,
      creditMaxAgeSeconds: 3600,
      reconciliationToleranceBase: 0,
      requiredDocuments: [],
      claimTypes: [],
      scorecardWeights: {},
    },
    masterVersion: 1,
    masterReceivedAt: "2026-10-20T00:00:00Z",
  };
  state.values = {
    list: { rows: [partner], next: null },
    workspace,
    scorecard: {
      score: 70,
      complete: true,
      components: { stock: 60, submission: 80 },
      weights: { stock: 50, submission: 50 },
      secondaryCentavos: 15000,
      priorCentavos: 10000,
      growthPct: 50,
      targetCentavos: 20000,
      nextAction: "Review stock: 60 / 100, the lowest component",
      audit: null,
    },
    "stock-health": {
      period: { from: "2026-09-23", to: "2026-10-20", days: 28 },
      stale: false,
      declaration: {
        id: "private-declaration",
        date: "2026-10-20",
        revision: 1,
      },
      rows: [
        {
          productId: "private-product-id",
          name: "Sample food",
          code: "FOOD",
          status: "healthy",
          onHandBase: 51,
          netSecondaryBase: null,
          priorSecondaryBase: null,
          onHand: { cases: 2, pieces: 3, unitsPerCase: 24 },
          daysOfInventory: null,
          nearExpiryBase: 0,
          expiredBase: 0,
          targetDays: { min: 7, max: 45 },
          nextAction: "Submit complete offtake",
          locations: [],
        },
      ],
      trend: [],
      freshnessDays: 0,
    } satisfies Health,
    orders: {
      rows: [
        {
          id: "private-order-id",
          order_number: "PO-100",
          customer_po_number: "CUSTOMER-PO",
          total_centavos: 12000,
          status: "submitted",
          promised_delivery_date: "2026-10-22",
          acknowledged_at: "2026-10-20T00:00:00Z",
        },
      ],
      next: null,
    },
  };
});
it("F-402 partner tabs follow grants and do not mount unauthorized finance or ordering queries", () => {
  const html = renderToStaticMarkup(
    createElement(DistributorWorkspace, { portal: true }),
  );
  expect(html).toContain("Sample Harbour");
  expect(html).toContain("Fictional sample data");
  expect(html).toContain("Review stock exceptions");
  for (const absent of [
    "Primary orders",
    "Claims",
    "Money",
    "Partner setup",
    "New distributor organization",
  ])
    expect(html).not.toContain(`>${absent}<`);
  expect(
    state.calls.every(
      (p) =>
        !p.includes("/credit") &&
        !p.includes("/orders") &&
        !p.includes("/claims"),
    ),
  ).toBe(true);
});
it("F-402 employee and partner workspaces cannot be mounted on the wrong surface", () => {
  let html = renderToStaticMarkup(createElement(DistributorWorkspace));
  expect(html).toContain("Open your distributor portal");
  expect(state.calls).toHaveLength(0);
  state.role = "super_admin";
  html = renderToStaticMarkup(
    createElement(DistributorWorkspace, { portal: true }),
  );
  expect(html).toContain("Open Channel Development");
  expect(state.calls).toHaveLength(0);
});
it("F-413 overview reconciles target, prior period and weakest component into a direct next action", () => {
  const html = renderToStaticMarkup(
    createElement(DistributorWorkspace, { portal: true }),
  );
  for (const text of [
    "Prior period",
    "100.00",
    "target",
    "200.00",
    "75% achieved",
    "50.0%",
    "Review stock: 60 / 100",
    "Review stock exceptions",
    "Daily secondary-sales trend",
  ])
    expect(html).toContain(text);
  expect(html.indexOf("Stock · weight")).toBeLessThan(
    html.indexOf("Submission · weight"),
  );
});
it("F-401 F-402 Channel Development appears in the existing office shell with scoped setup, never for a reader", () => {
  state.role = "super_admin";
  let html = renderToStaticMarkup(createElement(DistributorWorkspace));
  expect(html).toContain("Work · Channel Development");
  expect(html).toContain("Partner setup");
  expect(html).toContain("New distributor organization");
  state.role = "operations";
  html = renderToStaticMarkup(createElement(DistributorWorkspace));
  expect(html).not.toContain("Partner setup");
  expect(html).not.toContain("New distributor organization");
});
it("F-403 read-only order history shows public references, acknowledgement and promised dates, not private UUIDs", () => {
  const html = renderToStaticMarkup(
    createElement(Ordering, { workspace, command: vi.fn(), canWrite: false }),
  );
  for (const text of [
    "PO-100",
    "CUSTOMER-PO",
    "Acknowledged",
    "Promised delivery",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("private-order-id");
  expect(html).not.toContain("Raise a primary purchase order");
});
it("F-405 F-411 stock keeps unknown DOI unknown and shows cases plus pieces without hidden keys", () => {
  const html = renderToStaticMarkup(
    createElement(Stock, { workspace, command: vi.fn(), canWrite: false }),
  );
  expect(html).toContain("2 cases + 3 pieces");
  expect(html).toContain("Unknown");
  expect(html).toContain("Submit complete offtake");
  expect(html).not.toContain("Daily stock declaration");
  expect(html).not.toContain("private-product-id");
});
