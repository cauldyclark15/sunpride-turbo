import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "@sunpride/backend/data-model";
import { AdminWorkspace } from "./admin-workspace";
import { OrgAdmin, performOrgAction } from "./org-admin";
import { PeopleAdmin, performPeopleAssignment } from "./people-admin";
import { TeamsAdmin, performTeamAction } from "./teams-admin";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  historyId: null as string | null,
  selectedOverride: null as string | null,
  unitOverride: null as string | null,
  searchOverride: null as string | null,
  emptyIndex: 0,
  queryCalls: [] as { name: string; args: unknown }[],
  orgChoice: null as { unit: unknown; action: string } | null,
  orgError: "",
  tabOverride: "" as string,
  nullIndex: 0,
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never);
    state.queryCalls.push({ name, args });
    return state.values[name];
  },
  useMutation: () => vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === "organization" && state.tabOverride)
        return [state.tabOverride, vi.fn()];
      if (initial === null) {
        state.nullIndex += 1;
        if (state.nullIndex === 1 && state.orgChoice)
          return [state.orgChoice, vi.fn()];
        if (state.nullIndex === 1 && state.selectedOverride)
          return [state.selectedOverride, vi.fn()];
        if (state.nullIndex === 2 && state.unitOverride)
          return [state.unitOverride, vi.fn()];
        if (
          state.historyId &&
          state.nullIndex === (state.selectedOverride ? 2 : 3)
        )
          return [state.historyId, vi.fn()];
      }
      if (initial === "") {
        state.emptyIndex += 1;
        if (
          state.selectedOverride &&
          state.unitOverride &&
          state.searchOverride &&
          state.emptyIndex === 1
        )
          return [state.searchOverride, vi.fn()];
        if (state.orgChoice && state.orgError) return [state.orgError, vi.fn()];
      }
      return [
        typeof initial === "function" ? (initial as () => unknown)() : initial,
        vi.fn(),
      ];
    },
  };
});
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    isDisabled,
    isPending,
    onPress,
    ...props
  }: {
    children: React.ReactNode;
    isDisabled?: boolean;
    isPending?: boolean;
    onPress?: () => void;
    [key: string]: unknown;
  }) => {
    void onPress;
    return createElement(
      "button",
      { ...props, disabled: isDisabled || isPending },
      children,
    );
  },
  Input: (props: Record<string, unknown>) => createElement("input", props),
  TextField: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  Label: ({ children }: { children: React.ReactNode }) =>
    createElement("label", null, children),
  Select: Object.assign(
    ({ children }: { children: React.ReactNode }) =>
      createElement("div", null, children),
    {
      Trigger: ({ children }: { children: React.ReactNode }) =>
        createElement("div", null, children),
      Value: () => null,
      Indicator: () => null,
      Popover: ({ children }: { children: React.ReactNode }) =>
        createElement("div", null, children),
    },
  ),
  ListBox: Object.assign(
    ({ children }: { children: React.ReactNode }) =>
      createElement("div", null, children),
    {
      Item: ({ children, id }: { children: React.ReactNode; id: string }) =>
        createElement("option", { value: id }, children),
    },
  ),
}));
vi.mock("@sunpride/ui", () => ({
  WorkspaceIcon: () => createElement("span"),
  IconTile: ({ icon }: { icon: React.ReactNode }) =>
    createElement("span", null, icon),
  FormField: ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => createElement("label", null, label, children),
  Pager: ({ page, label }: { page: number; label: string }) =>
    createElement("nav", { "aria-label": label }, `Page ${page}`),
  Card: ({
    label,
    actions,
    children,
  }: {
    label: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    createElement(
      "section",
      null,
      createElement("h2", null, label),
      actions,
      children,
    ),
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
  ListRow: ({
    title,
    meta,
    value,
    action,
  }: {
    title: React.ReactNode;
    meta?: React.ReactNode;
    value?: React.ReactNode;
    action?: React.ReactNode;
  }) => createElement("div", null, title, meta, value, action),
  Notice: ({ title }: { title: string }) => createElement("p", null, title),
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  EmptyPanel: ({ title }: { title: string }) => createElement("p", null, title),
  DataTable: ({
    rows,
    columns,
    empty,
  }: {
    rows: Record<string, unknown>[];
    columns: {
      key: string;
      label: string;
      render: (row: Record<string, unknown>) => React.ReactNode;
    }[];
    empty: React.ReactNode;
  }) => {
    if (!rows.length) return empty;
    const headers = columns.map((column) =>
      createElement("th", { key: column.key }, column.label),
    );
    const body = rows.map((row) =>
      createElement(
        "tr",
        { key: String(row.id) },
        columns.map((column) =>
          createElement("td", { key: column.key }, column.render(row)),
        ),
      ),
    );
    return createElement(
      "table",
      null,
      createElement("thead", null, createElement("tr", null, headers)),
      createElement("tbody", null, body),
    );
  },
}));

const id = <T extends "orgUnits" | "profiles" | "positions">(value: string) =>
  value as Id<T>;
const root = {
  _id: id<"orgUnits">("root"),
  code: "SUNPRIDE",
  name: "Sunpride",
  typeCode: "NATIONAL",
  status: "active",
  effectiveFrom: 0,
} as Doc<"orgUnits">;
const region = {
  ...root,
  _id: id<"orgUnits">("region"),
  code: "NCR",
  name: "Metro Region",
  typeCode: "REGION",
  parentId: root._id,
} as Doc<"orgUnits">;
const area = {
  ...root,
  _id: id<"orgUnits">("area"),
  code: "MNL",
  name: "Manila Area",
  typeCode: "AREA",
  parentId: region._id,
  status: "inactive",
  effectiveTo: 9999999999999,
} as Doc<"orgUnits">;
const person = {
  _id: id<"profiles">("p1"),
  name: "Ana Reyes",
  email: "ana@example.com",
  authSubject: "subject-ana",
  role: "sales",
  status: "active",
  orgUnitId: region._id,
  positionId: id<"positions">("position"),
  supervisorSubject: "subject-manager",
  updatedAt: 0,
} as Doc<"profiles">;
const manager = {
  ...person,
  _id: id<"profiles">("p2"),
  name: "Maria Santos",
  authSubject: "subject-manager",
  role: "manager",
  employeeCode: "EMP-002",
  supervisorSubject: undefined,
} as Doc<"profiles">;
const permissions = {
  version: 1,
  role: "admin",
  capabilities: ["admin.manage", "org.read", "people.read"],
  scopeUnitIds: [root._id, region._id, area._id],
  orgUnitId: root._id,
};
const form = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] ?? null }) as Pick<FormData, "get">;
const html = (component: React.ReactNode) => {
  state.nullIndex = 0;
  state.emptyIndex = 0;
  return renderToStaticMarkup(component);
};

beforeEach(() => {
  state.historyId = null;
  state.selectedOverride = null;
  state.unitOverride = null;
  state.searchOverride = null;
  state.queryCalls = [];
  state.orgChoice = null;
  state.orgError = "";
  state.tabOverride = "";
  state.values = {
    "lib/capabilities:currentPermissions": permissions,
    "org/queries:tree": [root, region, area],
    "org/queries:types": [
      {
        _id: "type-national",
        code: "NATIONAL",
        label: "National",
        level: 0,
        active: true,
      },
      {
        _id: "type-region",
        code: "REGION",
        label: "Region",
        level: 1,
        active: true,
      },
      {
        _id: "type-area",
        code: "AREA",
        label: "Area from catalog",
        level: 2,
        active: true,
      },
    ],
    "people/queries:supervisorOptions": {
      page: [manager],
      continueCursor: "",
      isDone: true,
    },
    "teams/queries:list": { page: [], continueCursor: "", isDone: true },
    "people/queries:list": {
      page: [person, manager],
      continueCursor: "next",
      isDone: false,
    },
    "domains/profiles:list": [person, manager],
    "people/queries:history": [],
    "sfa/positions:list": [
      { _id: id<"positions">("position"), label: "Field Rep" },
    ],
  };
});

describe("Admin workspace tabs", () => {
  it("mounts territories, routes, outlets and assignments as administrator sections", () => {
    const view = html(createElement(AdminWorkspace));
    for (const title of ["Territories", "Routes", "Outlets", "Assignments"])
      expect(view).toContain(title);
    // Each tab mounts its own section card (the mock renders the Card label as
    // an h2), distinct from the always-visible tab buttons.
    for (const [tab, section] of [
      ["assignments", "Assignments"],
      ["routes", "Routes"],
      ["outlets", "Outlets"],
      ["territories", "Territories"],
    ] as const) {
      state.tabOverride = tab;
      expect(html(createElement(AdminWorkspace))).toContain(
        `<h2>${section}</h2>`,
      );
    }
  });
  it("keeps organization, people, and invitation sections inside the existing admin module", () => {
    const view = html(createElement(AdminWorkspace));
    expect(view).toContain("Organization");
    expect(view).toContain("People");
    expect(view).toContain("Teams");
    expect(view).toContain("Invitations");
    expect(view).toContain("<h2>Organization</h2>");
  });
  it("shows counts only for the active administration tab", () => {
    const organization = html(createElement(AdminWorkspace));
    expect(organization).toContain("<h2>Organization</h2>");
    expect(organization).not.toContain("people shown");
    expect(organization).not.toContain("teams shown");
    state.tabOverride = "people";
    expect(html(createElement(AdminWorkspace))).toContain("2 people shown");
    state.tabOverride = "teams";
    expect(html(createElement(AdminWorkspace))).toContain("0 teams shown");
  });
  it("preserves the invitation form and authorized accounts in their tab", () => {
    state.tabOverride = "invitations";
    state.values["domains/profiles:current"] = {
      role: "admin",
      status: "active",
    };
    state.values["domains/profiles:list"] = [person];
    state.values["domains/profiles:listInvitations"] = [
      {
        _id: "invite",
        email: "new@example.com",
        role: "viewer",
        status: "pending",
      },
    ];
    const view = html(createElement(AdminWorkspace));
    expect(view).toContain("Invite person");
    expect(view).toContain("new@example.com");
    expect(view).toContain("Send invitation");
  });
});

describe("Organization admin", () => {
  it("renders three hierarchy levels, type labels, effective dates, and inactive state", () => {
    const view = html(createElement(OrgAdmin));
    expect(view).toContain("Metro Region");
    expect(view).toContain("Manila Area");
    expect(view).toContain('data-depth="2"');
    expect(view).toContain("inactive");
    expect(view).toContain("Region");
  });
  it("keeps hierarchy order even when units arrive code-sorted", () => {
    state.values["org/queries:tree"] = [area, root, region];
    const view = html(createElement(OrgAdmin));
    expect(view.indexOf("Sunpride</span>")).toBeLessThan(
      view.indexOf("Metro Region</span>"),
    );
    expect(view.indexOf("Metro Region</span>")).toBeLessThan(
      view.indexOf("Manila Area</span>"),
    );
  });
  it("disables management controls without admin.manage", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      ...permissions,
      capabilities: ["org.read"],
    };
    expect(html(createElement(OrgAdmin))).toMatch(
      /disabled=""[^>]*>Create child/,
    );
  });
  it("routes create and reparent to their mutations with future Manila instants and reparent reason", async () => {
    const actions = {
      create: vi.fn(),
      edit: vi.fn(),
      reparent: vi.fn(),
      deactivate: vi.fn(),
    };
    const date = "2099-01-01";
    await performOrgAction(
      { unit: region, action: "create" },
      form({
        code: "MNL",
        name: "Manila",
        typeCode: "AREA",
        effectiveDate: date,
        reason: "Expansion",
      }),
      actions,
    );
    expect(actions.create).toHaveBeenCalledWith({
      parentId: region._id,
      code: "MNL",
      name: "Manila",
      typeCode: "AREA",
      effectiveFrom: Date.parse("2098-12-31T16:00:00Z"),
      reason: "Expansion",
    });
    await performOrgAction(
      { unit: area, action: "reparent" },
      form({
        parentId: root._id,
        effectiveDate: date,
        reason: "  Realign coverage  ",
      }),
      actions,
    );
    expect(actions.reparent).toHaveBeenCalledWith({
      unitId: area._id,
      parentId: root._id,
      effectiveFrom: Date.parse("2098-12-31T16:00:00Z"),
      reason: "Realign coverage",
    });
  });
  it("renders catalog-backed type choices and sends edit reason", async () => {
    state.orgChoice = { unit: region, action: "create" };
    const view = html(createElement(OrgAdmin));
    expect(view).toContain('value="AREA">Area from catalog');
    expect(view).not.toContain('value="TERRITORY"');
    expect(
      state.queryCalls.some((call) => call.name === "org/queries:types"),
    ).toBe(true);
    const edit = vi.fn();
    await performOrgAction(
      { unit: region, action: "edit" },
      form({ name: "Updated", reason: "  Correction  " }),
      { create: vi.fn(), edit, reparent: vi.fn(), deactivate: vi.fn() },
    );
    expect(edit).toHaveBeenCalledWith({
      unitId: region._id,
      name: "Updated",
      reason: "Correction",
    });
  });
  it("refuses empty reasons and propagates server errors verbatim", async () => {
    const actions = {
      create: vi.fn(),
      edit: vi.fn(),
      reparent: vi
        .fn()
        .mockRejectedValue(new Error("Parent interval does not cover child")),
      deactivate: vi.fn(),
    };
    await expect(
      performOrgAction(
        { unit: region, action: "edit" },
        form({ reason: "  ", name: "New" }),
        actions,
      ),
    ).rejects.toThrow("Reason required");
    await expect(
      performOrgAction(
        { unit: area, action: "reparent" },
        form({
          parentId: root._id,
          effectiveDate: "2099-01-01",
          reason: "Move",
        }),
        actions,
      ),
    ).rejects.toThrow("Parent interval does not cover child");
  });
  it("shows the verbatim server error inline", () => {
    state.orgChoice = { unit: region, action: "edit" };
    state.orgError = "Parent interval does not cover child";
    expect(html(createElement(OrgAdmin))).toContain(
      'role="alert" class="text-sm text-danger">Parent interval does not cover child',
    );
  });
});

describe("People admin", () => {
  it("loads supervisor options for the chosen unit rather than the legacy profiles list", () => {
    state.selectedOverride = person._id;
    state.unitOverride = region._id;
    state.searchOverride = "Mar";
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain("Search supervisors");
    expect(view).toContain('value="p2">Maria Santos');
    expect(state.queryCalls).toContainEqual({
      name: "people/queries:supervisorOptions",
      args: {
        orgUnitId: region._id,
        search: "Mar",
        paginationOpts: { numItems: 50, cursor: null },
      },
    });
    expect(
      state.queryCalls.some((call) => call.name === "domains/profiles:list"),
    ).toBe(false);
  });
  it("renders the paginated people list with role, position, unit, supervisor, and employee code", () => {
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain("Ana Reyes");
    expect(view).toContain("Field Rep");
    expect(view).toContain("Metro Region");
    expect(view).toContain("Maria Santos");
    expect(view).toContain("EMP-002");
    expect(view).toContain("Employee code");
    expect(view).toContain("Page 1");
  });
  it("submits assignment axes, code once, and reason", async () => {
    const assign = vi.fn();
    await performPeopleAssignment(
      person,
      form({
        orgUnitId: region._id,
        role: "manager",
        positionId: "position",
        supervisorId: "p2",
        employeeCode: "EMP-1",
        reason: "  Promotion  ",
      }),
      assign,
    );
    expect(assign).toHaveBeenCalledWith({
      profileId: person._id,
      orgUnitId: region._id,
      role: "manager",
      positionId: "position",
      supervisorId: "p2",
      employeeCode: "EMP-1",
      reason: "Promotion",
    });
    assign.mockClear();
    await performPeopleAssignment(
      { ...person, employeeCode: "EMP-1" },
      form({
        orgUnitId: region._id,
        role: "sales",
        employeeCode: "EMP-2",
        reason: "Transfer",
      }),
      assign,
    );
    expect(assign.mock.calls[0]?.[0]).not.toHaveProperty("employeeCode");
  });
  it("renders assignment history with effective interval and reason", () => {
    state.historyId = person._id;
    state.values["people/queries:history"] = [
      {
        _id: "assignment",
        role: "sales",
        orgUnitId: region._id,
        positionId: "position",
        effectiveFrom: Date.parse("2026-09-25T16:00:00Z"),
        reason: "Initial placement",
      },
    ];
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain("Assignment history");
    expect(view).toContain("Initial placement");
    expect(view).toContain("Field Rep");
  });
  it("disables assignment without admin.manage", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      ...permissions,
      capabilities: ["people.read"],
    };
    expect(html(createElement(PeopleAdmin))).toMatch(/disabled=""[^>]*>Assign/);
  });
});

describe("Teams admin", () => {
  const teamId = "team-1" as Id<"teams">;
  const team = {
    _id: teamId,
    code: "NCR-1",
    name: "NCR team",
    orgUnitId: region._id,
    status: "active",
    effectiveFrom: 0,
  };
  it("lists scoped teams and shows detail, members, and history", () => {
    state.tabOverride = "teams";
    state.values["teams/queries:list"] = {
      page: [team],
      continueCursor: "",
      isDone: true,
    };
    state.values["teams/queries:detail"] = {
      team,
      members: [
        {
          membership: { _id: "membership", effectiveFrom: 0 },
          profile: person,
        },
      ],
    };
    const tab = html(createElement(AdminWorkspace));
    expect(tab).toContain("NCR team");
    expect(state.queryCalls).toContainEqual({
      name: "teams/queries:list",
      args: { paginationOpts: { numItems: 25, cursor: null } },
    });
    state.selectedOverride = teamId;
    state.historyId = person._id;
    state.values["teams/queries:memberHistory"] = [
      { _id: "membership", effectiveFrom: 0, reason: "join" },
    ];
    const detail = html(createElement(TeamsAdmin));
    expect(detail).toContain("Current members");
    expect(detail).toContain("Ana Reyes");
    expect(detail).toContain("join");
    expect(state.queryCalls).toContainEqual({
      name: "teams/queries:memberHistory",
      args: { teamId, profileId: person._id },
    });
  });
  it("passes Manila effective dates and trimmed reasons for create/add/remove/deactivate", async () => {
    const actions = {
      create: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      deactivate: vi.fn(),
    };
    const date = "2099-01-01";
    const effective = Date.parse("2098-12-31T16:00:00Z");
    await performTeamAction(
      "create",
      form({
        code: "NCR-1",
        name: "NCR team",
        orgUnitId: region._id,
        effectiveDate: date,
        reason: "  Formed  ",
      }),
      actions,
    );
    expect(actions.create).toHaveBeenCalledWith({
      code: "NCR-1",
      name: "NCR team",
      orgUnitId: region._id,
      effectiveFrom: effective,
      reason: "Formed",
    });
    await performTeamAction(
      "add",
      form({ profileId: person._id, effectiveDate: date, reason: "  Join  " }),
      actions,
      teamId,
    );
    expect(actions.addMember).toHaveBeenCalledWith({
      teamId,
      profileId: person._id,
      effectiveFrom: effective,
      reason: "Join",
    });
    await performTeamAction(
      "remove",
      form({
        profileId: person._id,
        effectiveDate: date,
        reason: "  Transfer  ",
      }),
      actions,
      teamId,
    );
    expect(actions.removeMember).toHaveBeenCalledWith({
      teamId,
      profileId: person._id,
      effectiveTo: effective,
      reason: "Transfer",
    });
    await performTeamAction(
      "deactivate",
      form({ effectiveDate: date, reason: "  Closed  " }),
      actions,
      teamId,
    );
    expect(actions.deactivate).toHaveBeenCalledWith({
      teamId,
      effectiveTo: effective,
      reason: "Closed",
    });
  });
  it("hides management controls without admin.manage", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      ...permissions,
      capabilities: ["people.read"],
    };
    state.values["teams/queries:list"] = {
      page: [team],
      continueCursor: "",
      isDone: true,
    };
    state.selectedOverride = teamId;
    state.values["teams/queries:detail"] = { team, members: [] };
    const view = html(createElement(TeamsAdmin));
    expect(view).not.toContain("Create team</button>");
    expect(view).not.toContain("Add member</button>");
  });
});
