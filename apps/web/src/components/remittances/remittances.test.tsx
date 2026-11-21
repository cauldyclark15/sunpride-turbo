import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNELS,
  STATUSES,
} from "../../../../api/src/domains/remittances/model.js";
import {
  channelLabel,
  REMITTANCE_CHANNELS,
  REMITTANCE_STATUS,
  remittanceQuery,
  remittancesCsv,
  RemittancesView,
  type Remittance,
  type RemittanceList,
} from "./remittances";

vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(),
  useApi: vi.fn(),
  useMutate: () => ({ mutate: vi.fn() }),
}));

const row = (over: Partial<Remittance> = {}): Remittance => ({
  id: "r1",
  salesmanProfileId: "p1",
  salesman: "Ana Reyes",
  orgUnitId: "u1",
  branch: "Cebu branch",
  amountMinor: 5_000_000,
  channel: "palawan",
  channelOther: null,
  referenceNumber: "007-123-456",
  remittedAt: Date.parse("2026-11-17T06:00:00Z"),
  submittedAt: Date.parse("2026-11-17T06:05:00Z"),
  note: "Tuesday sales",
  status: "submitted",
  rejectReason: null,
  reviewedBy: null,
  reviewedAt: null,
  ...over,
});
const list = (over: Partial<RemittanceList> = {}): RemittanceList => ({
  items: [
    row(),
    row({
      id: "r2",
      channel: "other",
      channelOther: "M Lhuillier",
      amountMinor: 120_050,
      status: "rejected",
      rejectReason: "Reference not found",
      reviewedBy: "Finance",
      reviewedAt: Date.parse("2026-11-18T01:00:00Z"),
    }),
  ],
  salesmen: [{ id: "p1", name: "Ana Reyes" }],
  branches: [
    { id: "u1", name: "Cebu branch" },
    { id: "u2", name: "Davao branch" },
  ],
  canReview: true,
  ...over,
});
const filters = { from: "", to: "", unit: "", salesman: "", status: "" };
const render = (data: RemittanceList) =>
  renderToStaticMarkup(
    createElement(RemittancesView, {
      data,
      filters,
      onFilters: () => {},
      decide: async () => {},
      onPhoto: () => {},
    }),
  );

describe("Cash remittances (SP-0228)", () => {
  it("offers exactly the server's channels and statuses", () => {
    expect(REMITTANCE_CHANNELS.map((c) => c.code)).toEqual([...CHANNELS]);
    expect(Object.keys(REMITTANCE_STATUS)).toEqual([...STATUSES]);
  });

  it("lists amount, channel, reference, receipt and plain status; Finance gets Confirm / Reject", () => {
    const html = render(list());
    expect(html).toContain("Ana Reyes");
    expect(html).toContain("Cebu branch");
    expect(html).toContain("₱50,000.00");
    expect(html).toContain("Palawan Express");
    expect(html).toContain("007-123-456");
    expect(html).toContain("M Lhuillier");
    expect(html).toContain("View receipt");
    expect(html).toContain("Waiting for Finance");
    expect(html).toContain("Reference not found");
    expect(html).toContain("Confirm");
    expect(html).toContain("Download CSV");
    expect(html).toContain("All branches");
    // Only the one waiting row gets actions.
    expect(html.match(/>Confirm</g)?.length).toBe(1);
    expect(html).toContain("1 waiting for Finance");
  });

  it("hides Confirm / Reject from read-only viewers and shows a plain empty state", () => {
    expect(render(list({ canReview: false }))).not.toContain(">Confirm<");
    expect(render(list({ items: [] }))).toContain(
      "No cash remittances for these filters yet",
    );
  });

  it("exports a CSV with plain headings and safe cells", () => {
    const csv = remittancesCsv([
      row(),
      row({ id: "r3", note: '=cmd "x", y', channel: "gcash" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Remitted,Salesman,Branch,Amount (PHP),Sent through,Reference number,Status,Reason rejected,Checked by,Checked,Note",
    );
    expect(lines[1]).toContain(",50000.00,Palawan Express,007-123-456,Waiting for Finance,");
    expect(lines[2]).toContain(`"'=cmd ""x"", y"`);
    expect(lines[2]).toContain("GCash");
  });

  it("builds the filter query and names an unknown channel plainly", () => {
    expect(remittanceQuery(filters)).toBe("");
    expect(
      remittanceQuery({ ...filters, from: "2026-11-01", status: "submitted" }),
    ).toBe("?from=2026-11-01&status=submitted");
    expect(channelLabel({ channel: "bank_deposit", channelOther: null })).toBe(
      "Bank deposit",
    );
  });
});
