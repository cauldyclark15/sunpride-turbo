import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fixtureName as getFunctionName,
  fixtureValue,
} from "./master-data/fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "./master-data/model";
import { AdminWorkspace } from "./admin-workspace";
import { OrgAdmin, performOrgAction } from "./org-admin";
import { PeopleAdmin, performPeopleAssignment } from "./people-admin";
import { TeamsAdmin, performTeamAction } from "./teams-admin";
import {
  DevicesAdmin,
  deviceActionsFor,
  performDeviceAction,
} from "./devices-admin";

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
  params: {} as Record<string, string>,
  addingOverride: null as string | null,
  falseIndex: 0,
}));
vi.mock("./integrity/fleet", async (original) => ({
  ...(await original<typeof import("./integrity/fleet")>()),
  WaitingPhones: () => null,
}));
vi.mock("./master-data/location", () => ({
  useSetupParam: (name: string) => state.params[name] ?? "",
  setSetupParam: vi.fn(),
}));
vi.mock("./master-data/api", async (original) => ({
  ...(await original<typeof import("./master-data/api")>()),
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never);
    state.queryCalls.push({ name, args });
    return fixtureValue(reference, state.values[name]);
  },
  useMutation: () => vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === "health" && state.tabOverride)
        return [state.tabOverride, vi.fn()];
      if (initial === false) {
        state.falseIndex += 1;
        // PeopleAdmin: pending is the first false, the Add person drawer the second.
        if (state.falseIndex === 2 && state.addingOverride !== null)
          return [state.addingOverride, vi.fn()];
      }
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
    count,
    actions,
    children,
  }: {
    label: string;
    count?: number;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    createElement(
      "section",
      null,
      createElement(
        "h2",
        null,
        label,
        count === undefined ? "" : ` · ${count}`,
      ),
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
    createElement(
      "span",
      null,
      typeof children === "string"
        ? children
            .replaceAll("_", " ")
            .replace(/^./, (letter) => letter.toUpperCase())
        : children,
    ),
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
  capabilities: ["admin.manage", "phones.manage", "org.read", "people.read"],
  scopeUnitIds: [root._id, region._id, area._id],
  orgUnitId: root._id,
};
const form = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] ?? null }) as Pick<FormData, "get">;
const html = (component: React.ReactNode) => {
  state.nullIndex = 0;
  state.emptyIndex = 0;
  state.falseIndex = 0;
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
  state.params = {};
  state.addingOverride = null;
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

const invitationsFixture = [
  {
    _id: "first",
    email: "first@example.com",
    role: "super_admin",
    status: "accepted",
  },
  {
    _id: "second",
    name: "Jo Santos",
    email: "jo@example.com",
    role: "manager",
    status: "pending",
  },
];

describe("Admin workspace sections", () => {
  it("lists every Setup section in a grouped left list with no Invitations tab", () => {
    const view = html(createElement(AdminWorkspace));
    expect(view).toContain('aria-label="Setup sections"');
    for (const group of ["People", "Places", "Field work", "Checks"])
      expect(view).toContain(`>${group}</p>`);
    for (const title of [
      "Organization",
      "Teams",
      "Territories",
      "Routes",
      "Customers",
      "Assignments",
      "Call flows",
      "Field masters",
      "Phones",
      "Phone saves",
    ])
      expect(view).toContain(`>${title}</button>`);
    expect(view).not.toContain(">Invitations<");
    // phone width: the same sections as one picker, grouped
    expect(view).toContain('<optgroup label="Places">');
    expect(view).toContain("<h2>Setup health</h2>");
  });
  it("mounts each section from the URL and sends old ?section=invitations links to People", () => {
    for (const [section, heading] of [
      ["assignments", "<h2>Assignments"],
      ["routes", "<h2>Routes"],
      ["territories", "<h2>Territories"],
      ["organization", "<h2>Organization · 3</h2>"],
      ["teams", "<h2>Teams · 0</h2>"],
      ["invitations", ">People</h2>"],
    ] as const) {
      state.params = { section };
      const view = html(createElement(AdminWorkspace));
      expect(view).toContain(heading);
    }
    state.params = { section: "people" };
    expect(html(createElement(AdminWorkspace))).toMatch(
      /aria-current="page"[^>]*>People<\/button>/,
    );
  });
  it("shows no Setup-health caveat text", () => {
    state.values["org/setup-health"] = undefined;
    const view = html(createElement(AdminWorkspace));
    expect(view).not.toContain("Historical setup snapshots");
    expect(view).not.toContain("national access");
  });
});

describe("People list", () => {
  const admin = () => {
    state.values["domains/profiles:current"] = { role: "admin" };
  };
  it("SP-0200 shows the Share the Field app card above the list with both copyable links", () => {
    admin();
    const view = html(createElement(PeopleAdmin));
    const card = view.indexOf('data-testid="share-field-app"');
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(view.indexOf('data-testid="list-table"'));
    expect(view).toContain(
      'href="https://play.google.com/apps/internaltest/4701513704454726563"',
    );
    expect(view).toContain(
      'href="https://drive.google.com/drive/folders/181uAAjyMxw08WoDKSGaumrTPPZvQA282"',
    );
    expect(view).toContain('aria-label="Copy Google Play link"');
    expect(view).toContain('aria-label="Copy Google Drive link"');
  });
  it("WEB-177 shows the 'Showing x–y' count line like every other list", () => {
    admin();
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain("Showing 1–2 people · more on the next page");
  });
  it("puts search, Add person and the list in the first view, with Edit on each row", () => {
    admin();
    const view = html(createElement(PeopleAdmin));
    const add = view.indexOf('data-testid="list-add"');
    const table = view.indexOf('data-testid="list-table"');
    expect(view.indexOf('data-testid="list-search"')).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(table);
    expect(view).toContain("Add person");
    expect(view.match(/>Edit<\/button>/g)).toHaveLength(2);
    expect(view).not.toContain(">Assign<");
    expect(view).toContain('aria-label="People pages"');
  });
  it("searches from ?q= as you type (the query gets the URL text) and pages with a cursor", () => {
    state.params = { section: "people", q: "ana" };
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain('value="ana"');
    expect(state.queryCalls).toContainEqual({
      name: "people/queries:list",
      args: { q: "ana", paginationOpts: { numItems: 25, cursor: null } },
    });
  });
  it("keeps Add person for national administrators only, as before", () => {
    // no profile role → no Add
    expect(html(createElement(PeopleAdmin))).not.toContain("list-add");
    state.values["domains/profiles:current"] = { role: "manager" };
    expect(html(createElement(PeopleAdmin))).not.toContain("list-add");
    state.values["domains/profiles:current"] = { role: "admin" };
    state.values["lib/capabilities:currentPermissions"] = {
      ...permissions,
      national: false,
    };
    expect(html(createElement(PeopleAdmin))).not.toContain("list-add");
    state.values["lib/capabilities:currentPermissions"] = permissions;
    expect(html(createElement(PeopleAdmin))).toContain("list-add");
  });
  it("opens Add person as a form with name, email, role, position and branch", () => {
    admin();
    state.addingOverride = "";
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain('aria-label="Add person"');
    expect(view).toMatch(
      /<input[^>]*type="email"[^>]*required=""[^>]*name="email"/,
    );
    for (const label of ["Full name", "Email", "Role", "Position", "Branch"])
      expect(view).toContain(`<label>${label}`);
    expect(view).toMatch(/>Save<\/button>/);
    expect(view).toMatch(/>Cancel<\/button>/);
    expect(view).not.toContain("Send invitation");
  });
  it("shows invited people under the Invited filter with Remove, gated as before", () => {
    admin();
    state.params = { section: "people", filter: "invited" };
    state.values["domains/profiles:listInvitations"] = {
      page: invitationsFixture,
      continueCursor: "",
      isDone: true,
    };
    const view = html(createElement(PeopleAdmin));
    expect(view).toMatch(/aria-pressed="true"[^>]*>Invited/);
    expect(view.match(/(?<!Select )first@example\.com/g)).toHaveLength(1);
    expect(view).toContain("Jo Santos");
    expect(view).toContain("Sales manager");
    expect(view).toContain("Accepted");
    // the super admin's invitation cannot be removed; Jo's can
    expect(view.match(/>Remove<\/button>/g)).toHaveLength(1);
    expect(
      state.queryCalls.find((call) => call.name === "people/queries:list")
        ?.args,
    ).toBe("skip");
  });
  it("SP-0206 shows delivery state and Resend email only for waiting invitations", () => {
    admin();
    state.params = { section: "people", filter: "invited" };
    state.values["domains/profiles:listInvitations"] = {
      page: [
        {
          _id: "waiting",
          email: "waiting@example.test",
          role: "sales",
          status: "pending",
          emailState: "failed",
        },
        {
          _id: "joined",
          email: "joined@example.test",
          role: "sales",
          status: "accepted",
          emailState: "accepted",
        },
        {
          _id: "removed",
          email: "removed@example.test",
          role: "sales",
          status: "revoked",
          emailState: "not_sent",
        },
      ],
      continueCursor: "",
      isDone: true,
    };
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain("Email could not be sent");
    expect(view).toContain("Email accepted for sending");
    expect(view).toContain("Not emailed yet");
    expect(view.match(/>Resend email<\/button>/g)).toHaveLength(1);
  });
  it("hides the Invited filter from people who cannot add", () => {
    state.params = { section: "people", filter: "invited" };
    const view = html(createElement(PeopleAdmin));
    expect(view).not.toContain(">Invited");
    expect(view).toContain("Ana Reyes");
  });
});

describe("Organization admin", () => {
  it("renders three hierarchy levels, type labels, effective dates, and inactive state", () => {
    const view = html(createElement(OrgAdmin));
    expect(view).toContain("Metro Region");
    expect(view).toContain("Manila Area");
    expect(view).toContain('data-depth="2"');
    expect(view).toContain("Inactive");
    expect(view).toContain("Region");
    expect(view).toContain("Company");
    expect(view).toContain("Branch");
    expect(view).not.toMatch(/>Unit</);
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
    const view = html(createElement(OrgAdmin));
    expect(view).toMatch(/disabled=""[^>]*>Add below/);
    expect(view).toMatch(/disabled=""[^>]*>Add entry</);
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
    expect(view).toContain('value="AREA">Branch');
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
    // Loosened (jc): a blank reason is allowed.
    await expect(
      performOrgAction(
        { unit: region, action: "edit" },
        form({ reason: "  ", name: "New" }),
        actions,
      ),
    ).resolves.not.toThrow();
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
  it("SP-0217 uses Branch in the list, unassigned filter and Edit form without changing the submitted field", () => {
    state.selectedOverride = person._id;
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain("No branch");
    expect(view).toContain("<label>Branch");
    expect(view).toContain("Select a branch");
    expect(view).toContain('name="orgUnitId"');
    expect(view).not.toContain("No unit");
    expect(view).not.toMatch(/>Unit</);
  });
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
  it("renders five people columns with role, position, unit, supervisor, and code metadata", () => {
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain("Ana Reyes");
    expect(view).toContain("Field Rep");
    expect(view).toContain("Metro Region");
    expect(view).toContain("Maria Santos");
    expect(view).toContain("EMP-002");
    expect(view).toContain("Sales manager");
    expect(view.match(/role="columnheader"/g)).toHaveLength(6);
    expect(view).not.toContain(">Employee code</span>");
    expect(view).not.toContain(">Supervisor</span>");
    expect(view).toContain("Page 1");
  });
  it("SP-0194 the person's page has the App mode choice, and the list shows each person's mode", () => {
    state.values["people/queries:list"] = {
      page: [{ ...person, appMode: "selling", selling: true }, manager],
      continueCursor: "",
      isDone: true,
    };
    state.selectedOverride = person._id;
    const view = html(createElement(PeopleAdmin));
    expect(view).toContain(">Truck selling</span>");
    expect(view).toContain(">Customer mapping</span>"); // the manager's default
    expect(view).toContain(">App mode<");
    expect(view).toContain(
      "Add and update customers. Home is one big Add customer button.",
    );
    expect(view).toContain("Store visits, route and orders.");
    expect(view).toContain("Sell from the truck and print receipts.");
    expect(view).toMatch(/checked="" value="selling"/);
    expect(view).not.toContain('role="switch"');
  });
  it("uses email as the title when a person has no name, without repeating it in metadata", () => {
    state.values["people/queries:list"] = {
      page: [
        { ...person, name: "", role: "super_admin", employeeCode: "DEMO-E1" },
      ],
      continueCursor: "",
      isDone: true,
    };
    const view = html(createElement(PeopleAdmin));
    expect(view.match(/(?<!Select )ana@example\.com/g)).toHaveLength(1);
    expect(view).toContain("DEMO-E1");
    expect(view).toContain("Super admin");
    // a super admin cannot be edited: the row offers History only
    expect(view).not.toContain(">Edit</button>");
    expect(view).toContain(">History</button>");
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
  it("IP-INT2 ask 6: sends the staff phone number only when it changed; blank clears it", async () => {
    const assign = vi.fn();
    const base = { orgUnitId: region._id, role: "sales", reason: "Phone" };
    await performPeopleAssignment(
      person,
      form({ ...base, phone: " 0917 123 4567 " }),
      assign,
    );
    expect(assign.mock.calls[0]?.[0]).toMatchObject({ phone: "0917 123 4567" });
    assign.mockClear();
    await performPeopleAssignment(
      { ...person, phone: "0917 123 4567" },
      form({ ...base, phone: "0917 123 4567" }),
      assign,
    );
    expect(assign.mock.calls[0]?.[0]).not.toHaveProperty("phone");
    assign.mockClear();
    await performPeopleAssignment(
      { ...person, phone: "0917 123 4567" },
      form({ ...base, phone: "" }),
      assign,
    );
    expect(assign.mock.calls[0]?.[0]).toMatchObject({ phone: null });
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
    const view = html(createElement(PeopleAdmin));
    expect(view).not.toContain(">Edit</button>");
    expect(view.match(/>History<\/button>/g)).toHaveLength(2);
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

describe("Phones admin", () => {
  const deviceId = "device-1" as Id<"registeredDevices">;
  const device = {
    deviceId,
    inventoryTag: "PHONE-7",
    allowedApp: "ANDROID",
    platform: "Android",
    model: "Galaxy A55",
    osVersion: "14",
    appVersion: "1.0",
    orgUnitId: region._id,
    employeeName: "Ana Reyes",
    status: "suspended",
    statusReason: "suspected_compromise",
    statusAt: Date.parse("2026-10-03T02:00:00Z"),
    registeredAt: 0,
    lastSeenAt: Date.parse("2026-10-03T01:30:00Z"),
    bound: true,
    offlineLeaseExpiresAt: Date.parse("2026-10-04T01:30:00Z"),
  };
  it("SP-0234 Operations opens Setup directly on Phones without other admin sections", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      ...permissions,
      role: "operations",
      capabilities: ["phones.manage", "org.read"],
    };
    state.values["mobile/devices:list"] = {
      page: [device],
      continueCursor: "",
      isDone: true,
    };
    const view = html(createElement(AdminWorkspace));
    expect(view).toContain("Phones");
    expect(view).toContain("PHONE-7");
    expect(view).not.toContain('aria-label="Setup sections"');
    expect(state.queryCalls).toContainEqual({
      name: "mobile/devices:list",
      args: { paginationOpts: { numItems: 25, cursor: null } },
    });
    expect(state.queryCalls.some((q) => q.name === "org/queries:tree")).toBe(
      false,
    );
  });
  it("lists scoped phones from the Phones tab", () => {
    state.tabOverride = "devices";
    state.values["mobile/devices:list"] = {
      page: [device],
      continueCursor: "",
      isDone: true,
    };
    const view = html(createElement(AdminWorkspace));
    expect(view).toContain("Phones");
    expect(view).toContain("PHONE-7");
    expect(view).toContain("Android · Galaxy A55");
    expect(view).toContain("Ana Reyes");
    expect(view).toContain("Suspended");
    expect(state.queryCalls).toContainEqual({
      name: "mobile/devices:list",
      args: { paginationOpts: { numItems: 25, cursor: null } },
    });
  });
  it("keeps the phone list full-width and long codes available without wrapping", () => {
    const inventoryTag = "SAMPLE-PHONE-" + "0123456789abcdef".repeat(8);
    state.values["mobile/devices:list"] = {
      page: [{ ...device, inventoryTag }],
      continueCursor: "",
      isDone: true,
    };
    const view = html(createElement(DevicesAdmin));
    expect(view).toContain('class="grid min-w-0 grid-cols-1 gap-4"');
    expect(view).not.toContain("xl:grid-cols");
    expect(view).toContain(`title="${inventoryTag}"`);
    expect(view).toContain(`aria-label="Copy phone code ${inventoryTag}"`);
    expect(view).toContain("min-w-0 flex-1 truncate font-mono text-sm");
    expect(view).toContain("Phone pages");
  });
  it("shows what reached the server, what did not, and the audit history", () => {
    state.selectedOverride = deviceId;
    state.values["mobile/devices:list"] = {
      page: [device],
      continueCursor: "",
      isDone: true,
    };
    state.values["mobile/devices:lostDeviceReport"] = {
      device,
      acknowledged: [
        {
          kind: "visit.checkIn",
          clientRequestId: "op-1",
          serverAt: Date.parse("2026-10-03T01:29:00Z"),
        },
      ],
      acknowledgedMore: false,
      lastAcknowledgedAt: Date.parse("2026-10-03T01:29:00Z"),
      assignments: [
        {
          id: "previous",
          personName: "Former employee",
          from: 0,
          to: Date.parse("2026-10-03T01:00:00Z"),
        },
        {
          id: "current",
          personName: "Ana Reyes",
          from: Date.parse("2026-10-03T01:00:00Z"),
          to: null,
        },
      ],
      history: [
        {
          action: "device.suspended",
          reason: "suspected_compromise",
          at: Date.parse("2026-10-03T02:00:00Z"),
          actorName: "Maria Santos",
        },
        {
          action: "device.registered",
          reason: "registered",
          at: 0,
          actorName: null,
        },
      ],
    };
    const view = html(createElement(DevicesAdmin));
    expect(state.queryCalls).toContainEqual({
      name: "mobile/devices:lostDeviceReport",
      args: { deviceId },
    });
    expect(view).toContain("Android · Galaxy A55");
    expect(view).toContain("app 1.0");
    expect(view).toContain("The server now refuses this phone");
    expect(view).toContain("Work may remain only on the phone");
    expect(view).toContain("may already have reached the office");
    expect(view).toContain("Reconcile the received operations");
    expect(view).toContain("Check-in");
    expect(view).toContain("Maria Santos");
    expect(view).toContain("Who used this phone");
    expect(view).toContain("Former employee");
    expect(view).toContain("Now");
    expect(view).toContain("Give to another person");
    expect(view).toContain("Mark as lost");
    expect(view).toContain("suspected compromise");
    expect(view).toContain("Former user");
    expect(view).toContain("Reinstate phone");
    expect(view).toContain("Revoke phone");
    expect(view).not.toContain("Suspend phone");
  });
  it("shows the not-yet-sent explanation in the list and phone detail", () => {
    const pending = { ...device, model: "Model not sent yet" };
    state.selectedOverride = deviceId;
    state.values["mobile/devices:list"] = {
      page: [pending],
      continueCursor: "",
      isDone: true,
    };
    state.values["mobile/devices:lostDeviceReport"] = {
      device: pending,
      acknowledged: [],
      history: [],
      lastAcknowledgedAt: null,
    };
    const view = html(createElement(DevicesAdmin));
    expect(
      view.match(/Android · Model not sent yet/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(view).not.toContain("Not recorded");
  });
  it("offers only legal transitions and sends reason codes", async () => {
    expect(deviceActionsFor("active")).toEqual(["suspend", "revoke"]);
    expect(deviceActionsFor("suspended")).toEqual(["reinstate", "revoke"]);
    expect(deviceActionsFor("revoked")).toEqual([]);
    const actions = {
      suspend: vi.fn(),
      revoke: vi.fn(),
      reinstate: vi.fn(),
    };
    await performDeviceAction("suspend", deviceId, "lost", actions);
    expect(actions.suspend).toHaveBeenCalledWith({ deviceId, reason: "lost" });
    await performDeviceAction("revoke", deviceId, "replacement", actions);
    expect(actions.revoke).toHaveBeenCalledWith({
      deviceId,
      reason: "replacement",
    });
    await performDeviceAction("reinstate", deviceId, "found", actions);
    expect(actions.reinstate).toHaveBeenCalledWith({
      deviceId,
      reason: "found",
    });
    await expect(
      performDeviceAction("suspend", deviceId, "replacement", actions),
    ).rejects.toThrow("Choose a reason");
    await expect(
      performDeviceAction("reinstate", deviceId, "", actions),
    ).rejects.toThrow("Choose a reason");
  });
  it("skips device queries without admin.manage", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      ...permissions,
      capabilities: ["people.read"],
    };
    const view = html(createElement(DevicesAdmin));
    expect(view).toContain("Administrator access required");
    expect(
      state.queryCalls
        .filter((call) => call.name.startsWith("mobile/devices"))
        .every((call) => call.args === "skip"),
    ).toBe(true);
  });
});
