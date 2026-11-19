import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureName as getFunctionName } from "./master-data/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./master-data/model";
import { TerritoryAdmin, performTerritoryAction } from "./territory-admin";
import { RouteAdmin, performRouteAction } from "./route-admin";

afterEach(() => vi.restoreAllMocks());

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  selection: "" as string,
  action: "" as string,
  error: "" as string,
  nullIndex: 0,
  emptyIndex: 0,
  effectiveDate: "",
  mode: "territory" as "territory" | "route",
  noSalesperson: false,
  assigned: {} as Record<string, unknown[]>,
  personOptions: undefined as unknown,
}));
vi.mock("./master-data/api", async (original) => ({
  ...(await original<typeof import("./master-data/api")>()),
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    if (
      name === "people/queries:list" &&
      args !== "skip" &&
      (args as { territoryId?: string }).territoryId
    )
      return state.personOptions;
    if (
      name === "territories/queries:salespeopleAt" &&
      args !== "skip" &&
      Object.keys(state.assigned).length
    )
      return (
        state.assigned[(args as { territoryId: string }).territoryId] ?? []
      );
    return state.values[name];
  },
  useMutation: () => vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === false && state.noSalesperson) return [true, vi.fn()];
      if (initial === null) {
        state.nullIndex++;
        if (
          state.action &&
          state.nullIndex === (state.mode === "route" ? 3 : 2)
        )
          return [state.action, vi.fn()];
        if (state.selection) return [state.selection, vi.fn()];
      }
      if (initial === "") {
        state.emptyIndex++;
        if (state.emptyIndex === 3 && state.effectiveDate)
          return [state.effectiveDate, vi.fn()];
        if (state.error) return [state.error, vi.fn()];
      }
      return [
        typeof initial === "function" ? (initial as () => unknown)() : initial,
        vi.fn(),
      ];
    },
  };
});
vi.mock("@heroui/react", async (original) => ({
  ...(await original<typeof import("@heroui/react")>()),
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
}));
const form = (values: Record<string, string | string[]>) =>
  ({
    get: (name: string) =>
      Array.isArray(values[name])
        ? ((values[name] as string[])[0] ?? null)
        : (values[name] ?? null),
    getAll: (name: string) =>
      Array.isArray(values[name])
        ? (values[name] as string[])
        : values[name]
          ? [values[name] as string]
          : [],
  }) as Pick<FormData, "get" | "getAll">;
const id = <T extends "routes" | "territories">(value: string) =>
  value as Id<T>;
const territory = {
  _id: id<"territories">("territory"),
  code: "NCR",
  name: "Metro territory",
  status: "active",
  effectiveFrom: 0,
};
const route = {
  _id: id<"routes">("route"),
  code: "R1",
  name: "Monday beat",
  status: "active",
  effectiveFrom: 0,
  weekdayTemplate: [1],
  cycleDays: 7,
};
const render = (node: React.ReactNode) => {
  state.nullIndex = 0;
  state.emptyIndex = 0;
  return renderToStaticMarkup(node);
};
beforeEach(() => {
  state.selection = "";
  state.action = "";
  state.error = "";
  state.calls = [];
  state.noSalesperson = false;
  state.assigned = {};
  state.personOptions = undefined;
  state.effectiveDate = "";
  state.mode = "territory";
  state.values = {
    "lib/capabilities:currentPermissions": {
      capabilities: [
        "territory.read",
        "territory.manage",
        "route.read",
        "route.manage",
      ],
      scopeUnitIds: ["unit"],
    },
    "territories/queries:list": {
      page: [territory],
      continueCursor: "",
      isDone: true,
    },
    "territories/queries:detail": { territory, owner: { orgUnitId: "unit" } },
    "territories/queries:salespeopleAt": [],
    "territories/queries:ownershipHistory": [],
    "territories/routes:list": {
      page: [route],
      continueCursor: "",
      isDone: true,
    },
    "territories/routes:detail": {
      route,
      territory: { territoryId: territory._id },
      salespeople: [],
    },
    "territories/routes:history": { territories: [], salespeople: [] },
    "org/queries:tree": [
      { _id: "unit", code: "NCR", name: "Metro", status: "active" },
    ],
    "people/queries:list": { page: [], continueCursor: "", isDone: true },
  };
});
describe("unmounted territory and route administration", () => {
  it("uses territory-filtered people rather than the company-wide first page for assignment", () => {
    state.selection = territory._id;
    state.action = "assign";
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["territory.read", "territory.manage"],
      scopeUnitIds: ["unit", "sibling", "child"],
    };
    state.values["people/queries:list"] = {
      page: [
        {
          _id: "outsider",
          name: "Sibling salesperson",
          status: "active",
          orgUnitId: "sibling",
        },
      ],
      continueCursor: "outsider",
      isDone: false,
    };
    state.personOptions = {
      page: [
        { _id: "seller", name: "Owner salesperson" },
        { _id: "child-seller", name: "Child unit salesperson" },
      ],
      continueCursor: "child-seller",
      isDone: false,
    };
    const html = render(createElement(TerritoryAdmin));
    const options = html.match(
      /<select[^>]*name="profileId"[^>]*>[\s\S]*?<\/select>/,
    )?.[0];
    expect(options).toContain("Owner salesperson");
    expect(options).toContain("Child unit salesperson");
    expect(options).not.toContain("Sibling salesperson");
    expect(html).toContain("Search salespeople");
    expect(html).toContain("Salespeople pages");
    expect(state.calls).toContainEqual({
      name: "people/queries:list",
      args: {
        territoryId: territory._id,
        paginationOpts: { numItems: 50, cursor: null },
      },
    });
  });
  it("filters at the selected Manila effective date with only one required date control", () => {
    state.selection = territory._id;
    state.action = "assign";
    state.effectiveDate = "2099-01-02";
    const html = render(createElement(TerritoryAdmin));
    expect(state.calls).toContainEqual({
      name: "people/queries:list",
      args: {
        territoryId: territory._id,
        asOf: Date.parse("2099-01-01T16:00:00Z"),
        paginationOpts: { numItems: 50, cursor: null },
      },
    });
    expect(html.match(/name="effectiveDate"/g)).toHaveLength(1);
    const date = html.match(/<input[^>]*name="effectiveDate"[^>]*>/)?.[0];
    expect(date).toContain('type="date"');
    expect(date).toContain('required=""');
    expect(date).toContain('value="2099-01-02"');
  });
  it("keeps the assignment picker empty while loading or when the owning unit has no active people", () => {
    state.selection = territory._id;
    state.action = "assign";
    const loading = render(createElement(TerritoryAdmin));
    expect(loading).toContain("Loading salespeople…");
    expect(loading).toMatch(
      /<select[^>]*name="profileId"[^>]*required=""[^>]*aria-busy="true"/,
    );
    state.personOptions = { page: [], continueCursor: "", isDone: true };
    const empty = render(createElement(TerritoryAdmin));
    expect(empty).toContain(
      "No active people found in this territory’s owning unit.",
    );
    expect(empty).not.toContain("Loading salespeople…");
    expect(empty).toMatch(
      /<select[^>]*name="profileId"[^>]*required=""[^>]*><option value="" selected="">Select person<\/option><\/select>/,
    );
  });
  it("does not fetch assignment options outside the Add salesperson form", () => {
    render(createElement(TerritoryAdmin));
    expect(state.calls).not.toContainEqual({
      name: "people/queries:list",
      args: expect.objectContaining({ territoryId: expect.any(String) }),
    });
  });
  it.each(["create", "edit"])(
    "renders outlined text fields in the territory %s form without changing required fields",
    (action) => {
      state.action = action;
      if (action === "edit") state.selection = territory._id;
      const html = render(createElement(TerritoryAdmin));
      const fields = [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag);
      for (const name of action === "create"
        ? ["code", "name", "channel"]
        : ["name", "channel"]) {
        const field = fields.find((tag) => tag.includes(`name="${name}"`));
        expect(field).toBeDefined();
        // Use the real HeroUI input: its default style removes the native border.
        expect(field).toContain('data-slot="input"');
        expect(field).toMatch(/class="[^"]*\bborder border-border\b/);
        if (name === "channel") expect(field).not.toContain('required=""');
        else expect(field).toContain('required=""');
      }
      expect(html).toContain('name="boundaryGeoJson"');
      expect(html).toContain('name="reason" required=""');
      if (action === "create") {
        expect(html).toContain('name="orgUnitId" required=""');
        expect(html).toContain('type="date" required="" name="effectiveDate"');
        expect(html).toContain('type="date" name="endDate"');
      } else {
        expect(html).toContain('value="Metro territory"');
      }
    },
  );
  it("filters each listed territory by its own current salesperson assignment", () => {
    const empty = {
      ...territory,
      _id: id<"territories">("empty"),
      name: "Unstaffed territory",
    };
    state.values["territories/queries:list"] = {
      page: [territory, empty],
      continueCursor: "",
      isDone: true,
    };
    state.noSalesperson = true;
    state.assigned = {
      [territory._id]: [{ profileId: "seller" }],
      [empty._id]: [],
    };
    const html = render(createElement(TerritoryAdmin));
    expect(html).toContain("Unstaffed territory");
    expect(html).not.toContain("Metro territory</button>");
    expect(
      state.calls.filter(
        (call) =>
          call.name === "territories/queries:salespeopleAt" &&
          call.args !== "skip",
      ),
    ).toHaveLength(2);
  });
  it("renders scoped territory list and owner detail, with capability-gated controls", () => {
    const html = render(createElement(TerritoryAdmin));
    expect(html).toContain("Metro territory");
    expect(html).toContain("No salesperson assigned");
    expect(html).toMatch(
      /Metro territory<\/div><div[^>]*>NCR · .* · No salesperson<\/div>/,
    );
    expect(state.calls).toContainEqual({
      name: "territories/queries:list",
      args: { paginationOpts: { numItems: 25, cursor: null } },
    });
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["territory.read"],
      scopeUnitIds: [],
    };
    expect(html).toContain(">Add territory</button>");
    expect(html).toMatch(/>Edit<\/button>/);
    // without territory.manage there is nothing to add (permission unchanged)
    expect(render(createElement(TerritoryAdmin))).not.toContain(
      "Add territory",
    );
  });
  it("lists all routes before a territory is picked, with Add route enabled and Edit per row", () => {
    state.mode = "route";
    const html = render(createElement(RouteAdmin));
    expect(html).toContain("All territories");
    expect(html).toContain("Monday beat");
    expect(html).toMatch(/<button[^>]*>Add route<\/button>/);
    expect(html).not.toMatch(/disabled=""[^>]*>Add route/);
    expect(html).toMatch(/>Edit<\/button>/);
    expect(state.calls).toContainEqual({
      name: "territories/routes:list",
      args: { paginationOpts: { numItems: 25, cursor: null } },
    });
  });
  it("picks the territory inside the Add route form", async () => {
    state.mode = "route";
    state.action = "create";
    const html = render(createElement(RouteAdmin));
    expect(html).toMatch(/<h3[^>]*>Add route<\/h3>/);
    expect(html).toMatch(/<select name="territoryId" required="">/);
    expect(html).toContain("Pick a territory");
    const create = vi.fn();
    await performRouteAction(
      "create",
      form({
        territoryId: territory._id,
        code: "R9",
        name: "Friday beat",
        effectiveDate: "2099-01-01",
        reason: "New beat",
      }),
      {
        create,
        edit: vi.fn(),
        move: vi.fn(),
        duplicateTemplate: vi.fn(),
        assignSalesperson: vi.fn(),
        endSalespersonAssignment: vi.fn(),
        deactivate: vi.fn(),
      },
    );
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      territoryId: territory._id,
      code: "R9",
    });
  });
  it("renders route territory selector, scoped list, template and disabled controls without route.manage", () => {
    state.selection = territory._id;
    const html = render(createElement(RouteAdmin));
    expect(html).toContain("Metro territory");
    expect(html).toContain("Monday beat");
    expect(state.calls).toContainEqual({
      name: "territories/routes:list",
      args: {
        territoryId: territory._id,
        paginationOpts: { numItems: 25, cursor: null },
      },
    });
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["route.read"],
      scopeUnitIds: [],
    };
    expect(render(createElement(RouteAdmin))).not.toContain("Add route");
  });
  it("sends create, move and duplicate to correct mutations with reason and Manila UTC instant", async () => {
    const actions = {
      create: vi.fn(),
      edit: vi.fn(),
      move: vi.fn(),
      duplicateTemplate: vi.fn(),
      assignSalesperson: vi.fn(),
      endSalespersonAssignment: vi.fn(),
      deactivate: vi.fn(),
    };
    const date = "2099-01-01",
      effectiveFrom = Date.parse("2098-12-31T16:00:00Z");
    await performRouteAction(
      "create",
      form({
        territoryId: territory._id,
        code: "NEW",
        name: "New",
        weekday: ["1", "3"],
        cycleDays: "14",
        effectiveDate: date,
        endDate: "2099-01-08",
        reason: "  New coverage ",
      }),
      actions,
    );
    expect(actions.create).toHaveBeenCalledWith({
      territoryId: territory._id,
      code: "NEW",
      name: "New",
      weekdayTemplate: [1, 3],
      cycleDays: 14,
      effectiveFrom,
      effectiveTo: Date.parse("2099-01-07T16:00:00Z"),
      reason: "New coverage",
    });
    await performRouteAction(
      "move",
      form({
        territoryId: territory._id,
        effectiveDate: date,
        reason: "Rebalance",
      }),
      actions,
      route._id,
    );
    expect(actions.move).toHaveBeenCalledWith({
      routeId: route._id,
      territoryId: territory._id,
      effectiveFrom,
      reason: "Rebalance",
    });
    await performRouteAction(
      "duplicate",
      form({
        territoryId: territory._id,
        code: "COPY",
        name: "Copy",
        effectiveDate: date,
        reason: "Reuse",
      }),
      actions,
      route._id,
    );
    expect(actions.duplicateTemplate).toHaveBeenCalledWith({
      routeId: route._id,
      territoryId: territory._id,
      code: "COPY",
      name: "Copy",
      effectiveFrom,
      reason: "Reuse",
    });
  });
  it("accepts today's territory start without changing other actions or end-date rules", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T04:00:00Z"));
    const actions = {
      create: vi.fn(),
      edit: vi.fn(),
      transferOwner: vi.fn(),
      assignSalesperson: vi.fn(),
      endSalespersonAssignment: vi.fn(),
      deactivate: vi.fn(),
    };
    const values = {
      code: "TODAY",
      name: "Today's territory",
      channel: "General trade",
      orgUnitId: "unit",
      effectiveDate: "2026-11-19",
      endDate: "2026-11-20",
      reason: "Starts today",
    };
    await performTerritoryAction("create", form(values), actions);
    expect(actions.create).toHaveBeenCalledWith({
      code: "TODAY",
      name: "Today's territory",
      channel: "General trade",
      boundaryGeoJson: undefined,
      orgUnitId: "unit",
      effectiveFrom: Date.parse("2026-11-18T16:00:00Z"),
      effectiveTo: Date.parse("2026-11-19T16:00:00Z"),
      reason: "Starts today",
    });
    actions.create.mockClear();
    await expect(
      performTerritoryAction(
        "create",
        form({ ...values, effectiveDate: "2026-11-18" }),
        actions,
      ),
    ).rejects.toThrow("Choose today or a future effective date.");
    await expect(
      performTerritoryAction(
        "create",
        form({ ...values, effectiveDate: "2026-02-30" }),
        actions,
      ),
    ).rejects.toThrow("Invalid date");
    await expect(
      performTerritoryAction(
        "create",
        form({ ...values, endDate: "2026-11-19" }),
        actions,
      ),
    ).rejects.toThrow("Choose a future effective date.");
    expect(actions.create).not.toHaveBeenCalled();
    for (const action of ["transfer", "assign", "end", "deactivate"] as const) {
      await expect(
        performTerritoryAction(action, form(values), actions, territory._id),
      ).rejects.toThrow("Choose a future effective date.");
    }
    expect(actions.transferOwner).not.toHaveBeenCalled();
    expect(actions.assignSalesperson).not.toHaveBeenCalled();
    expect(actions.endSalespersonAssignment).not.toHaveBeenCalled();
    expect(actions.deactivate).not.toHaveBeenCalled();
  });
  it("sends territory create and transfer with owner unit, reason and future date; propagates errors", async () => {
    const actions = {
      create: vi.fn(),
      edit: vi.fn(),
      transferOwner: vi.fn(),
      assignSalesperson: vi.fn(),
      endSalespersonAssignment: vi.fn(),
      deactivate: vi.fn(),
    };
    const effectiveFrom = Date.parse("2098-12-31T16:00:00Z");
    await performTerritoryAction(
      "create",
      form({
        code: "N",
        name: "North",
        orgUnitId: "unit",
        effectiveDate: "2099-01-01",
        reason: "  launch  ",
      }),
      actions,
    );
    expect(actions.create).toHaveBeenCalledWith({
      code: "N",
      name: "North",
      orgUnitId: "unit",
      channel: undefined,
      boundaryGeoJson: undefined,
      effectiveFrom,
      reason: "launch",
    });
    await performTerritoryAction(
      "transfer",
      form({
        orgUnitId: "unit",
        effectiveDate: "2099-01-01",
        reason: "transfer",
      }),
      actions,
      territory._id,
    );
    expect(actions.transferOwner).toHaveBeenCalledWith({
      territoryId: territory._id,
      orgUnitId: "unit",
      effectiveFrom,
      reason: "transfer",
    });
    actions.transferOwner.mockRejectedValueOnce(new Error("Outside scope"));
    await expect(
      performTerritoryAction(
        "transfer",
        form({
          orgUnitId: "unit",
          effectiveDate: "2099-01-01",
          reason: "transfer",
        }),
        actions,
        territory._id,
      ),
    ).rejects.toThrow("Outside scope");
    await expect(
      performRouteAction(
        "move",
        form({
          territoryId: territory._id,
          effectiveDate: "2099-01-01",
          reason: " ",
        }),
        { ...actions, move: vi.fn(), duplicateTemplate: vi.fn() },
        route._id,
      ),
    ).rejects.toThrow("Reason required");
  });
  it("shows mutation errors inline in forms", () => {
    state.selection = territory._id;
    state.action = "edit";
    state.error = "Outside scope";
    expect(render(createElement(TerritoryAdmin))).toContain('role="alert"');
    state.mode = "route";
    expect(render(createElement(RouteAdmin))).toContain('role="alert"');
  });
});
