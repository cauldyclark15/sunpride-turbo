import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntakeEditor } from "./intake";
import { TradeTerms } from "./terms";
import { DeductionCase } from "./deductions";
import { CustomerPortal, PortalLogin } from "./portal";
import { getWebNavigation } from "../../config/navigation";
import { canAccessWebModule } from "../../lib/module-access";
import { safeCsv } from "./export";
import type { Options, Intake, Term, Deduction, PortalOverview } from "./model";

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({ ...state, refetch: vi.fn() }),
  mutate: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock("../../lib/auth/session", () => ({
  useSession: () => ({
    signIn: vi.fn(),
    signOut: vi.fn(),
    profile: { subject: "reviewer" },
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
const options: Options = {
  bindings: [],
  products: [],
  types: [
    {
      id: "type-secret-id",
      code: "SHORT",
      label: "Short delivery",
      sla_days: 7,
      effective_from: "2020-01-01",
      effective_to: null,
    },
  ],
  owners: [{ id: "owner-secret-id", name: "Account team" }],
  invoices: [],
};
beforeEach(() => {
  state.data = undefined;
  state.error = undefined;
});
describe("F-306 F-307 F-309 F-611 modern trade web", () => {
  it("F-309 exports quoted UTF-8 CSV without spreadsheet formula execution", () => {
    const result = safeCsv([
      ["Account", "Note"],
      ["=SUM(A1)", 'a,b"c'],
    ]);
    expect(result.startsWith("\uFEFF")).toBe(true);
    expect(result).toContain('"\'=SUM(A1)"');
    expect(result).toContain('"a,b""c"');
    expect(result.endsWith("\r\n")).toBe(true);
  });
  it("F-306 displays validation and preserves original-document action without offering read-only confirmation", () => {
    const row: Intake = {
      id: "po-secret-id",
      po_number: "PO-123",
      service_date: "2026-10-20",
      branchLabel: "Sample supermarket",
      status: "review",
      revision: 1,
      exceptions: ["Delivery date needs review"],
      lines: [
        {
          productCode: "P1",
          uom: "PC",
          quantity: 2,
          requestedPriceCentavos: 1200,
          productName: "Sample grocery pack",
          approvedUnitPriceCentavos: 1300,
          grossCentavos: 2 * 1300,
          exceptions: ["PO price differs from the approved price"],
        },
      ],
      order_id: null,
      created_at: "2026-10-20",
    };
    const edit = renderToStaticMarkup(<IntakeEditor row={row} canEdit />);
    expect(edit).toContain("Download original");
    expect(edit).toContain("PO price differs");
    expect(edit).toContain("Sample grocery pack");
    expect(edit).toContain("Approved unit:");
    expect(edit).toContain("Gross before offers:");
    const unchecked = renderToStaticMarkup(
      <IntakeEditor
        canEdit
        row={{
          ...row,
          exceptions: [],
          lines: row.lines.map((l) => ({
            ...l,
            exceptions: [],
            approvedUnitPriceCentavos: null,
            grossCentavos: null,
          })),
        }}
      />,
    );
    expect(unchecked).toMatch(
      /<button[^>]*disabled=""[^>]*>Confirm into Orders<\/button>/,
    );
    expect(edit).toContain('disabled=""');
    const read = renderToStaticMarkup(
      <IntakeEditor row={row} canEdit={false} />,
    );
    expect(read).not.toContain("Confirm into Orders");
    expect(read).not.toContain("Download original");
    expect(read).not.toContain("po-secret-id");
  });
  it("F-307 renders all approved condition kinds, independent approval and peso/rate units", () => {
    const term: Term = {
      id: "term-secret-id",
      name: "Sample supply agreement",
      scope_kind: "branch",
      scope_key: "A1",
      scopeLabel: "Sample supermarket",
      status: "submitted",
      source: "sample",
      effective_from: "2026-01-01",
      effective_to: null,
      requested_by: "creator",
      conditions: [
        {
          id: "line1",
          kind: "listing_fee",
          product_code: null,
          product_name: null,
          uom: null,
          amount_centavos: "100000",
          rate_bps: null,
        },
        {
          id: "line2",
          kind: "rebate",
          product_code: null,
          product_name: null,
          uom: null,
          amount_centavos: null,
          rate_bps: 200,
        },
        {
          id: "line3",
          kind: "logistics_allowance",
          product_code: null,
          product_name: null,
          uom: null,
          amount_centavos: null,
          rate_bps: 100,
        },
      ],
      events: [],
    };
    state.data = { rows: [term] };
    const html = renderToStaticMarkup(
      <TradeTerms
        options={options}
        canEdit={false}
        canApprove
        userId="reviewer"
      />,
    );
    expect(html).toContain("Listing fee");
    expect(html).toContain("Logistics allowance");
    expect(html).toContain("₱1,000.00");
    expect(html).toContain("2%");
    expect(html).toContain("Approve");
    expect(html).not.toContain("term-secret-id");
    expect(
      renderToStaticMarkup(
        <TradeTerms
          options={options}
          canEdit={false}
          canApprove
          userId="creator"
        />,
      ),
    ).not.toContain(">Approve<");
  });
  it("F-309 queue case names its owner, age, due date, claim and actionable customer dispute", () => {
    const row: Deduction = {
      id: "deduction-secret-id",
      branchLabel: "Sample supermarket",
      type_id: "type-secret-id",
      type_label: "Short delivery",
      amountCentavos: 10000,
      status: "disputed",
      reference: "REM-1",
      received_on: "2026-09-01",
      claim_reference: "CLAIM-1",
      invoice_number: "INV-1",
      owner_profile_id: "owner-secret-id",
      owner_name: "Account team",
      due_on: "2026-09-08",
      age_days: 49,
      overdue_days: 42,
      disputes: [
        {
          id: "dispute-secret-id",
          reference: "CUSTOMER-REF",
          message: "Please check the receiving record",
          status: "open",
          response: null,
          created_at: "2026-10-20",
        },
      ],
      events: [],
    };
    const html = renderToStaticMarkup(
      <DeductionCase
        row={row}
        options={options}
        canEdit={false}
        canApprove={false}
      />,
    );
    expect(html).toContain("Account team");
    expect(html).toContain("42 days past SLA");
    expect(html).toContain("CLAIM-1");
    expect(html).not.toContain("Send response");
    expect(html).not.toContain("deduction-secret-id");
  });
  it("F-611 customer layout exposes only PO milestones, invoice replicas and dispute submission", () => {
    const data: PortalOverview = {
      purchaseOrders: [
        {
          id: "secret-po-id",
          poNumber: "PO-123",
          branch: "Sample supermarket",
          status: "fulfilled",
          orderNumber: "SP-001",
          amountCentavos: 10000,
          milestones: [
            { stage: "received", at: "2026-10-20" },
            { stage: "delivered", at: "2026-10-20" },
          ],
          deliverySource: "Order status; delivery proof feed not connected",
        },
      ],
      invoices: [
        {
          id: "secret-invoice-id",
          branch: "Sample supermarket",
          invoiceNumber: "INV-123",
          amountCentavos: 10000,
          issuedOn: "2026-10-20",
          dueOn: "2026-11-20",
          source: "sample",
          receivedAt: "2026-10-20",
        },
      ],
      deductions: [
        {
          id: "secret-deduction-id",
          branch: "Sample supermarket",
          amountCentavos: 1000,
          status: "open",
          type: "Short delivery",
          reference: "REM-123",
          claimReference: null,
          dueOn: "2026-10-27",
          ageDays: 1,
          invoiceNumber: "INV-123",
          disputes: [],
        },
      ],
    };
    state.data = data;
    const html = renderToStaticMarkup(<CustomerPortal />);
    expect(html).toContain("PO received");
    expect(html).toContain("Delivered");
    expect(html).toContain("Sample SAP invoice");
    expect(html).toContain("Submit dispute");
    expect(html).not.toContain("secret-po-id");
    expect(html).not.toContain("Account setup");
    expect(html).not.toContain("Owner");
    state.error = { message: "Customer portal access is not active" };
    const denied = renderToStaticMarkup(<CustomerPortal />);
    expect(denied).not.toContain("INV-123");
    expect(denied).not.toContain("PO-123");
    expect(denied).toContain("Return to customer sign in");
  });
  it("F-611 sign-in is separate from employee layout and never echoes a credential", () => {
    const html = renderToStaticMarkup(<PortalLogin />);
    expect(html).toContain('type="password"');
    expect(html).toContain("Customer portal");
    expect(html).not.toContain("Workspaces");
  });
  it("F-306 modern trade mounts under Work, with no employee navigation for an external customer", () => {
    expect(
      getWebNavigation("/modern-trade").moduleTabs.some(
        (t) => t.label === "Modern trade",
      ),
    ).toBe(true);
    expect(canAccessWebModule("modern-trade", "admin")).toBe(true);
    expect(canAccessWebModule("modern-trade", "external_customer")).toBe(false);
  });
});
