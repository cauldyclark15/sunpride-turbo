import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { StoresPage } from "./stores";

vi.mock("../../../lib/auth", () => ({
  usePermissions: () => ({
    can: (c: string) => ["outlet.read", "outlet.enrol.propose"].includes(c),
  }),
}));
vi.mock("../../../lib/api", () => ({ useApi: () => ({ data: { total: 1 } }) }));
vi.mock("./shared", () => ({
  buttonClass: "",
  usePageQuery: () => ({
    params: new URLSearchParams("tab=new"),
    link: (p: string) => p,
    set: vi.fn(),
    hrefWith: () => "/customers?tab=new",
  }),
}));
vi.mock("../../store-gathering/tab", () => ({ useWaitingCount: () => 1 }));
vi.mock("../../customers/customer-editor", () => ({
  CustomerEditor: () => null,
  useCustomerReference: () => ({ index: {}, enrollmentFields: [] }),
}));
vi.mock("../../customers/customer-list", () => ({
  FILTER_DEPENDENTS: {},
  useCustomerList: () => ({ data: { rows: [], total: 0 } }),
  CustomerListView: ({ onEdit }: { onEdit?: unknown }) => (
    <div>
      {onEdit ? "Open submitted customer profile" : "No profile action"}
    </div>
  ),
}));
vi.mock("../kit/drawer", () => ({ Drawer: () => null }));

it("SP-0250 a salesman can open the New customers profile without office editing rights", () => {
  const html = renderToStaticMarkup(<StoresPage />);
  expect(html).toContain("Open submitted customer profile");
  expect(html).toContain("Prospects to complete (a manager approves)");
  expect(html).not.toContain("Upload customers");
});
