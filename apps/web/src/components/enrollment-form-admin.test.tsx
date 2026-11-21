import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./customers/customer-editor", () => ({
  useCustomerReference: () => ({
    index: { all: () => [{ code: "10", name: "Key Accounts" }] },
  }),
}));
vi.mock("../lib/auth", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("../lib/api", () => ({
  apiFetch: vi.fn(),
  mutate: vi.fn(),
  useApi: () => ({ data: undefined }),
}));

const { FormEditor, ENROLLMENT_SAVED, reorderEnrollment } =
  await import("./enrollment-form-admin");

const field = {
  key: "cf_size",
  label: "Store size sqm",
  kind: "number",
  choices: [],
  requiredChannels: [],
  requiredTypes: [],
};

describe("Setup > Enrollment form (SP-0229)", () => {
  it("sits in a Setup card with labelled fields and button-styled actions", () => {
    const html = renderToStaticMarkup(
      <FormEditor initial={{ revision: 1, fields: [field] }} />,
    );
    expect(html).toContain('aria-label="Enrollment form"');
    expect(html).toContain("rounded-2xl");
    expect(html).toContain("Field 1 · Store size sqm");
    expect(html).toMatch(
      /<button[^>]*class="[^"]*rounded-lg[^"]*"[^>]*>Move up</,
    );
    expect(html).toContain("Field name");
    expect(html).toContain("Key Accounts");
  });
  it("shows the saved confirmation after the editor reloads", () => {
    const html = renderToStaticMarkup(
      <FormEditor
        initial={{ revision: 2, fields: [field] }}
        notice={ENROLLMENT_SAVED}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Enrollment form saved.");
  });
  it("reorders fields", () => {
    const b = { ...field, key: "b" };
    expect(reorderEnrollment([field, b], 1, 0).map((f) => f.key)).toEqual([
      "b",
      "cf_size",
    ]);
  });
});
