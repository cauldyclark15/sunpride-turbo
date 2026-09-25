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
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "domains/profiles:current") return state.profile;
    if (name === "lib/capabilities:currentPermissions")
      return state.permissions;
    if (name === "coverage/plans:list") return [];
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
    useState: (initial: unknown) => [
      initial === "plan"
        ? state.tab
        : typeof initial === "function"
          ? (initial as () => unknown)()
          : initial,
      vi.fn(),
    ],
    useRef: () => ({ current: false }),
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales-force",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@sunpride/ui", () => ({
  PageHeader: ({ title }: { title: string }) =>
    createElement("h1", null, title),
  WorkspaceModuleTabs: () => null,
  MetricCard: () => null,
  DataTable: () => null,
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
const render = () => {
  state.calls = [];
  return renderToStaticMarkup(
    createElement(ModuleWorkspace, { module: "sales-force" }),
  );
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
    expect(html).toContain("Coverage plans");
    expect(html).toContain("Mounted planner");
    for (const tab of ["Plan", "Review", "Planned visits", "History"])
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
    expect(html).toContain("Planned visits");
    expect(
      state.calls.find((c) => c.name === "people/queries:list")?.args,
    ).toBe("skip");
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
    expect(render()).toContain("Plan versions");
    expect(
      state.calls.find((c) => c.name === "people/queries:list")?.args,
    ).not.toBe("skip");
  });
  it("viewer with mcp.read sees read-only coverage, denied profile never mounts queries", () => {
    state.profile.role = "viewer";
    state.permissions = {
      role: "viewer",
      capabilities: ["mcp.read", "people.read"],
      scopeUnitIds: ["unit"],
    };
    expect(render()).toContain("Coverage plans");
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
    expect(render()).not.toContain("Coverage plans");
    expect(
      state.calls.some(
        (c) =>
          c.name.startsWith("coverage/") || c.name === "people/queries:list",
      ),
    ).toBe(false);
  });
});
