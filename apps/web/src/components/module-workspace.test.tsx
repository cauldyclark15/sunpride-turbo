import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleWorkspace } from "./module-workspace";

const state = vi.hoisted(() => ({
  profile: {
    status: "active",
    role: "manager",
    _id: "manager",
    name: "Manager",
    authSubject: "manager-subject",
  },
  permissions: {
    role: "manager",
    capabilities: ["mcp.read", "mcp.plan", "mcp.approve"],
    scopeUnitIds: ["unit"],
  },
  calls: [] as { name: string; args: unknown }[],
  orders: [] as Array<{
    _id: string;
    orderNumber: string;
    customerCode: string;
    status: string;
    total: number;
  }>,
  workflows: [] as Array<{ entityId: string }>,
  customers: [] as Array<{
    _id: string;
    code: string;
    name: string;
    channel: string;
    territory: string;
    creditLimit: number;
  }>,
  products: [] as Array<{
    _id: string;
    code: string;
    name: string;
    category: string;
    unitPrice: number;
    active: boolean;
  }>,
  pathname: "/sales-force",
  decisions: [] as Array<{ label: string; onPress: () => void }>,
  mutations: [] as Array<{ name: string; args: unknown }>,
  tab: "plan",
  hookCalls: 0,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "domains/profiles:current") return state.profile;
    if (name === "domains/orders:list") return state.orders;
    if (name === "domains/workflows:pending") return state.workflows;
    if (name === "domains/masterData:customers") return state.customers;
    if (name === "domains/masterData:products") return state.products;
    if (name === "lib/capabilities:currentPermissions")
      return state.permissions;
    if (name === "coverage/plans:list") return [];
    if (name === "coverage/plans:detail")
      return {
        plan: {
          _id: "selected-plan",
          version: 1,
          status: "draft",
          preparedBy: "someone",
          preparedAt: 1,
          assigneeProfileId: "manager",
        },
        slots: [],
        warnings: [],
      };
    if (name === "coverage/discovery:list")
      return { page: [], continueCursor: "0", isDone: true };
    if (name === "coverage/activation:plannedForMonth") return [];
    if (name === "people/queries:list")
      return {
        page: [
          { _id: "seller", name: "Sales", orgUnitId: "unit", status: "active" },
        ],
        isDone: true,
      };
    if (name === "people/queries:history") return [{ effectiveFrom: 0 }];
    return undefined;
  },
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    return vi.fn(async (args: unknown) => {
      state.mutations.push({ name, args });
      return {};
    });
  },
}));
vi.mock("@heroui/react", async (original) => {
  const actual = await original<typeof import("@heroui/react")>();
  return {
    ...actual,
    Button: ({
      children,
      onPress,
    }: {
      children: React.ReactNode;
      onPress?: () => void;
    }) => {
      if (
        onPress &&
        typeof children === "string" &&
        (children === "Approve" || children === "Reject")
      )
        state.decisions.push({ label: children, onPress });
      return createElement("button", null, children);
    },
  };
});
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => {},
    useState: (initial: unknown) => {
      state.hookCalls++;
      return [
        state.hookCalls === 5 &&
        [
          "visits",
          "history",
          "review",
          "calendar",
          "route",
          "map",
          "exceptions",
          "export",
        ].includes(state.tab)
          ? {
              id: "selected-plan",
              assigneeId: "manager",
              assigneeName: "Sales",
            }
          : initial === "plan"
            ? state.tab
            : typeof initial === "function"
              ? (initial as () => unknown)()
              : initial,
        vi.fn(),
      ];
    },
    useRef: () => ({ current: false }),
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@sunpride/ui", () => ({
  FormField: ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => createElement("label", null, label, children),
  Pager: ({ page, label }: { page: number; label: string }) =>
    createElement("nav", { "aria-label": label }, `Page ${page}`),
  PageHeader: ({
    title,
    meta,
    actions,
  }: {
    title: string;
    meta?: React.ReactNode;
    actions?: React.ReactNode;
  }) =>
    createElement(
      "header",
      null,
      createElement("h1", null, title),
      meta,
      actions,
    ),
  WorkspaceModuleTabs: ({ items }: { items: Array<{ label: string }> }) =>
    createElement(
      "nav",
      { "aria-label": "Commercial tabs" },
      items.map((item) =>
        createElement("span", { key: item.label }, item.label),
      ),
    ),
  WorkspaceIcon: () => null,
  Card: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement("section", { "data-label": label }, label, children),
  UnderlineTabs: ({
    items,
  }: {
    items: readonly (readonly [string, string])[];
  }) =>
    createElement(
      "nav",
      null,
      items.map(([id, label]) => createElement("button", { key: id }, label)),
    ),
  MetricCard: ({
    label,
    value,
    detail,
  }: {
    label: string;
    value: string;
    detail?: string;
  }) => createElement("article", null, label, ":", value, detail),
  DataTable: ({
    rows,
    columns,
    empty,
  }: {
    rows: Array<{ id: string }>;
    columns: Array<{
      key: string;
      label: string;
      render: (row: { id: string }) => React.ReactNode;
    }>;
    empty: React.ReactNode;
  }) =>
    rows.length
      ? createElement(
          "table",
          null,
          createElement(
            "thead",
            null,
            createElement(
              "tr",
              null,
              columns.map((column) =>
                createElement("th", { key: column.key }, column.label),
              ),
            ),
          ),
          createElement(
            "tbody",
            null,
            rows.map((row) =>
              createElement(
                "tr",
                { key: row.id },
                columns.map((column) =>
                  createElement("td", { key: column.key }, column.render(row)),
                ),
              ),
            ),
          ),
        )
      : empty,
  EmptyPanel: () => null,
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
}));
vi.mock("./admin-workspace", () => ({ AdminWorkspace: () => null }));
vi.mock("./route-admin", () => ({ RouteAdmin: () => null }));
vi.mock("./outlet-admin", () => ({ OutletAdmin: () => null }));
vi.mock("./outlet-assignments", () => ({ OutletAssignments: () => null }));
vi.mock("./imports-workspace", () => ({ ImportsWorkspace: () => null }));
vi.mock("./inventory-workspace", () => ({ InventoryWorkspace: () => null }));
vi.mock("./coverage-planner", () => ({
  CoveragePlanner: () => createElement("p", null, "Mounted planner"),
}));
const render = (
  module:
    | "sales-force"
    | "dashboard"
    | "analytics"
    | "master-data"
    | "imports"
    | "orders"
    | "workflows" = "sales-force",
) => {
  state.calls = [];
  state.hookCalls = 0;
  return renderToStaticMarkup(createElement(ModuleWorkspace, { module }));
};
beforeEach(() => {
  state.profile = {
    status: "active",
    role: "manager",
    _id: "manager",
    name: "Manager",
    authSubject: "manager-subject",
  };
  state.permissions = {
    role: "manager",
    capabilities: ["mcp.read", "mcp.plan", "mcp.approve"],
    scopeUnitIds: ["unit"],
  };
  state.tab = "plan";
  state.orders = [];
  state.workflows = [];
  state.customers = [];
  state.products = [];
  state.decisions = [];
  state.mutations = [];
  state.pathname = "/sales-force";
});

describe("calm generic modules", () => {
  it("matches Home and Reports navigation without repeated KPI captions", () => {
    for (const [slug, title] of [
      ["dashboard", "Home"],
      ["analytics", "Reports"],
    ] as const) {
      state.pathname = `/${slug}`;
      const html = render(slug);
      expect(html).toContain(`<h1>${title}</h1>`);
      for (const label of [
        "Products",
        "Customers",
        "Low stock",
        "Open orders",
        "Approvals",
        "Sales today",
      ])
        expect(html).toContain(`${label}:—`);
      for (const caption of [
        "Active",
        "Trading",
        "Need stock",
        "In progress",
        "Waiting",
        "Order value",
      ])
        expect(html).not.toContain(caption);
      expect(html).not.toContain('data-label="Focus"');
      expect(html).not.toContain("Executive control center");
      expect(html).not.toContain("Realtime Convex");
    }
  });

  it("puts one Commercial header above tabs on every commercial page", () => {
    state.profile.role = "super_admin";
    for (const slug of ["orders", "master-data", "imports"] as const) {
      state.pathname = `/${slug}`;
      const html = render(slug);
      expect(html.match(/<h1>Commercial<\/h1>/g)).toHaveLength(1);
      expect(html.indexOf("<h1>Commercial</h1>")).toBeLessThan(
        html.indexOf('aria-label="Commercial tabs"'),
      );
      if (slug === "orders") {
        expect(html).toContain("0 orders");
        expect(html).toContain("New order");
        expect(html).not.toContain('data-label="Orders"');
      } else {
        expect(html).not.toContain("New order");
      }
    }
    state.pathname = "/master-data";
    const html = render("master-data");
    expect(html).toContain('data-label="Products"');
    expect(html).toContain('data-label="Customers"');
    expect(html).not.toContain("idempotent");
  });

  it("shows names above codes for products, customers, and orders", () => {
    state.profile.role = "super_admin";
    state.products = [
      {
        _id: "product-1",
        code: "P-1",
        name: "Pineapple juice",
        category: "Juice",
        unitPrice: 120,
        active: true,
      },
    ];
    state.customers = [
      {
        _id: "customer-1",
        code: "C-1",
        name: "Acme Stores",
        channel: "Retail",
        territory: "North",
        creditLimit: 500,
      },
    ];
    state.pathname = "/master-data";
    const master = render("master-data");
    expect(master).toContain("Products");
    expect(master).toContain("Customers");
    expect(master).toMatch(
      /Pineapple juice<\/span><span class="font-mono text-xs text-muted">P-1/,
    );
    expect(master).toMatch(
      /Acme Stores<\/span><span class="font-mono text-xs text-muted">C-1/,
    );
    expect(master).not.toContain("<th>Code</th>");

    state.orders = [
      {
        _id: "order-1",
        orderNumber: "SO-001",
        customerCode: "C-1",
        status: "approved",
        total: 120,
      },
      {
        _id: "order-2",
        orderNumber: "SO-002",
        customerCode: "C-2",
        status: "sent_to_sap",
        total: 200,
      },
    ];
    state.pathname = "/orders";
    const orders = render("orders");
    expect(orders).toContain("2 orders");
    expect(orders).toMatch(/<th>Order<\/th>.*<th>Customer<\/th>/);
    expect(orders).toMatch(
      /Acme Stores<\/span><span class="font-mono text-xs text-muted">C-1/,
    );
    expect(orders).toContain("SO-002");
    expect(orders).toContain("C-2");
    expect(orders).toContain("Sent");
    expect(orders).not.toContain("sent_to_sap");
    expect(orders).not.toContain("<th>Decision</th>");
    expect(orders).not.toContain('data-label="Orders"');
    state.orders = state.orders.slice(0, 1);
    expect(render("orders")).toContain("1 order");
    expect(render("orders")).not.toContain("1 orders");
  });

  it("gates module queries behind the active profile", () => {
    state.profile.status = "inactive";
    state.pathname = "/orders";
    expect(render("orders")).toContain("Access denied");
    expect(state.calls.map((call) => call.name)).toEqual([
      "domains/profiles:current",
    ]);
  });

  it("shows decisions only for visible waiting orders and preserves decision arguments", async () => {
    state.profile.role = "super_admin";
    state.orders = [
      {
        _id: "waiting-1",
        orderNumber: "SO-001",
        customerCode: "C-1",
        status: "pending_approval",
        total: 120,
      },
      {
        _id: "done-1",
        orderNumber: "SO-002",
        customerCode: "C-2",
        status: "approved",
        total: 200,
      },
    ];
    state.workflows = [{ entityId: "waiting-1" }];
    state.pathname = "/workflows";
    const approvals = render("workflows");
    expect(approvals).toContain("<h1>Approvals</h1>1 waiting");
    expect(approvals).toContain("SO-001");
    expect(approvals).not.toContain("SO-002");
    expect(approvals).toContain("Waiting");
    expect(approvals).toContain("<th>Decision</th>");
    expect(state.calls).toContainEqual({
      name: "domains/masterData:customers",
      args: "skip",
    });
    for (const [label, decision] of [
      ["Reject", "rejected"],
      ["Approve", "approved"],
    ] as const) {
      state.decisions.find((button) => button.label === label)?.onPress();
      expect(state.mutations).toContainEqual({
        name: "domains/orders:decide",
        args: {
          orderId: "waiting-1",
          decision,
          comment: `${decision === "approved" ? "Approved" : "Rejected"} from operations workspace`,
        },
      });
    }
    state.workflows = [];
    state.decisions = [];
    const empty = render("workflows");
    expect(empty).toContain("<h1>Approvals</h1>0 waiting");
    expect(empty).toContain("Nothing waiting");
    expect(empty).toContain("border border-border");
    expect(empty).not.toContain("<th>Decision</th>");
  });
});
