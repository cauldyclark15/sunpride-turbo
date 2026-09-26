import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "@sunpride/backend/data-model";
import { TerritoryAdmin, performTerritoryAction } from "./territory-admin";
import { RouteAdmin, performRouteAction } from "./route-admin";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  selection: "" as string,
  action: "" as string,
  error: "" as string,
  nullIndex: 0,
  mode: "territory" as "territory" | "route",
  noSalesperson: false,
  assigned: {} as Record<string, unknown[]>,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
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
      if (initial === "" && state.error) return [state.error, vi.fn()];
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
  return renderToStaticMarkup(node);
};
beforeEach(() => {
  state.selection = "";
  state.action = "";
  state.error = "";
  state.calls = [];
  state.noSalesperson = false;
  state.assigned = {};
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
    expect(render(createElement(TerritoryAdmin))).toMatch(
      /disabled=""[^>]*>Create territory/,
    );
  });
  it("explains the route selector before a territory is chosen", () => {
    state.mode = "route";
    const html = render(createElement(RouteAdmin));
    expect(html).toContain("Choose a territory to see its routes");
    expect(html).toMatch(/disabled=""[^>]*>Create route/);
    expect(html).toContain("Metro territory · NCR");
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
    expect(render(createElement(RouteAdmin))).toMatch(
      /disabled=""[^>]*>Create route/,
    );
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
