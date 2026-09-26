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
  tab: "plan",
  hookCalls: 0,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "domains/profiles:current") return state.profile;
    if (name === "domains/orders:list" || name === "domains/workflows:pending")
      return [];
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
  useMutation: () => vi.fn(async () => ({})),
}));
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
  usePathname: () => "/sales-force",
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
  WorkspaceModuleTabs: () => null,
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
  DataTable: ({ rows }: { rows: unknown[] }) =>
    createElement("table", null, `${rows.length} rows`),
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
});

describe("sales force coverage module", () => {
  it("mounts planner and all four tabs for manager", () => {
    const html = render();
    expect(html).toContain("Plans");
    expect(html).toContain("Mounted planner");
    for (const tab of ["Plan", "Review", "Visits", "History"])
      expect(html).toContain(`>${tab}</button>`);
  });
  it("sales sees own planner, visits and history, but cannot review", () => {
    state.profile.role = "sales";
    state.permissions = {
      role: "sales",
      capabilities: ["mcp.read", "mcp.plan"],
      scopeUnitIds: ["unit"],
    };
    expect(render()).not.toContain(">Review</button>");
    state.tab = "visits";
    const html = render();
    expect(html).toContain("Visits");
    expect(state.calls.some((c) => c.name === "people/queries:list")).toBe(
      false,
    );
    expect(
      state.calls.find((c) => c.name === "coverage/activation:plannedForMonth")
        ?.args,
    ).toMatchObject({ assigneeProfileId: "manager" });
  });
  it("analyst is read-only and has history and visits without review", () => {
    state.profile.role = "analyst";
    state.permissions = {
      role: "analyst",
      capabilities: ["mcp.read", "people.read"],
      scopeUnitIds: ["unit"],
    };
    const html = render();
    expect(html).toContain("Mounted planner");
    expect(html).not.toContain(">Review</button>");
    state.tab = "history";
    expect(render()).toContain("Plan history");
    expect(state.calls.some((c) => c.name === "people/queries:list")).toBe(
      false,
    );
    expect(state.calls.some((c) => c.name === "coverage/discovery:list")).toBe(
      true,
    );
  });
  it("viewer with mcp.read sees read-only coverage, denied profile never mounts queries", () => {
    state.profile.role = "viewer";
    state.permissions = {
      role: "viewer",
      capabilities: ["mcp.read", "people.read"],
      scopeUnitIds: ["unit"],
    };
    expect(render()).toContain("Plans");
    state.profile.status = "disabled";
    expect(render()).toContain("Access denied");
    expect(
      state.calls.some(
        (c) =>
          c.name.startsWith("coverage/") ||
          c.name === "lib/capabilities:currentPermissions",
      ),
    ).toBe(false);
  });
  it("hides all coverage panels when current permissions deny mcp.read and skips denied queries", () => {
    state.permissions.capabilities = [];
    expect(render()).not.toContain("Plans");
    expect(
      state.calls.some(
        (c) =>
          c.name.startsWith("coverage/") || c.name === "people/queries:list",
      ),
    ).toBe(false);
  });
  it("offers new scoped tabs to mcp.read operations without people.read", () => {
    state.profile.role = "operations";
    state.permissions = {
      role: "operations",
      capabilities: ["mcp.read"],
      scopeUnitIds: ["unit"],
    };
    const html = render();
    for (const tab of [
      "Calendar",
      "Routes",
      "Map",
      "Workload",
      "Exceptions",
      "Export",
    ])
      expect(html).toContain(`>${tab}</button>`);
    expect(html).not.toContain(">Review</button>");
    expect(state.calls.some((c) => c.name === "coverage/discovery:list")).toBe(
      true,
    );
    expect(state.calls.some((c) => c.name.startsWith("people/"))).toBe(false);
  });
  it("mounts selected history only and keeps other view subscriptions unmounted", () => {
    state.tab = "history";
    const html = render();
    expect(html).toContain("Plan history");
    expect(state.calls.some((c) => c.name === "coverage/history:list")).toBe(
      true,
    );
    for (const name of [
      "coverage/views:calendar",
      "coverage/views:byRoute",
      "coverage/views:workload",
      "coverage/map:forPlan",
      "coverage/exceptions:forPlan",
      "coverage/exports:schedule",
    ])
      expect(state.calls.some((c) => c.name === name)).toBe(false);
  });
});
