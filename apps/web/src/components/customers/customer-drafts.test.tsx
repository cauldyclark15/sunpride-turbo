import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CustomerDraftList,
  CustomerDraftRows,
  type SharedCustomerDraft,
} from "./customer-drafts";

const data = vi.hoisted(() => ({
  response: { rows: [] as SharedCustomerDraft[], hasMore: false },
  error: null as { message: string } | null,
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({ data: data.response, error: data.error }),
}));
vi.mock("./customer-editor", () => ({
  useCustomerReference: () => ({ enrollmentFields: [] }),
}));
const draft = (
  id: string,
  profile: SharedCustomerDraft["profile"] = {},
): SharedCustomerDraft => ({
  id,
  profile,
  status: "draft",
  canApprove: false,
  addedByName: "Sample salesman",
  updatedAt: 1795651200000,
});

describe("SP-0244 office drafts", () => {
  it("shows unnamed and partly typed customers read-only, with no approval/edit action", () => {
    const out = renderToStaticMarkup(
      <CustomerDraftRows
        rows={[
          draft("one"),
          draft("two", {
            form: {
              registeredName: "Sample draft",
              firstName: "Ana",
              email: "unfinished@",
              mobileNo: "09",
            },
            details: { creditLimit: "1." },
            sameAsCustomer: false,
            shipToParty: "Separate delivery",
          }),
        ]}
      />,
    );
    expect(out).toContain("Unnamed customer");
    expect(out).toContain("Sample draft");
    expect(out).toContain("unfinished@");
    expect(out).toContain("Separate delivery");
    expect(out).toContain("Draft — not for approval");
    expect(out).toContain("Not taken yet");
    expect(out).toContain("Not set yet");
    expect(out).not.toMatch(/<button|<input|<form|\/approve|\/amend/);
  });
  it("explains when drafts become visible and keeps more than one row", () => {
    data.response = { rows: [draft("one"), draft("two")], hasMore: true };
    const out = renderToStaticMarkup(<CustomerDraftList />);
    expect(out).toContain("after the phone syncs");
    expect(out.match(/data-testid="customer-office-draft"/g)).toHaveLength(2);
    expect(out).toMatch(/disabled=""[^>]*>Previous/);
    expect(out).toContain(">Next</button>");
  });
  it("shows a failed read instead of an empty success message", () => {
    data.error = { message: "Could not load drafts" };
    const out = renderToStaticMarkup(<CustomerDraftList />);
    expect(out).toContain('role="alert"');
    expect(out).toContain("Could not load drafts");
    expect(out).not.toContain("No customer drafts");
    data.error = null;
  });
});
