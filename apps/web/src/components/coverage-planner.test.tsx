import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "@sunpride/backend/data-model";
import { CoverageGrid, toggleVisit } from "./coverage-grid";
import {
  CoveragePlanner,
  PlanEditor,
  reviseCoveragePlan,
  saveCoverageAssignment,
  saveCoverageOutlets,
  saveCoverageSlots,
  submitCoveragePlan,
} from "./coverage-planner";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  selected: "",
  index: 0,
  editorError: "",
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    return args === "skip" ? undefined : state.values[name];
  },
  useMutation: () => vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      state.index++;
      if (state.index === 3 && state.selected) return [state.selected, vi.fn()];
      if (state.index === 10 && state.editorError)
        return [state.editorError, vi.fn()];
      return [
        typeof initial === "function" ? (initial as () => unknown)() : initial,
        vi.fn(),
      ];
    },
  };
});
const id = <
  T extends "coveragePlans" | "profiles" | "outlets" | "territories" | "routes",
>(
  value: string,
) => value as Id<T>;
const visitOutlet = {
  outletId: id<"outlets">("outlet-1"),
  territoryId: id<"territories">("territory-1"),
  routeId: id<"routes">("route-1"),
  sequence: 3,
  expectedDurationMinutes: 30,
  requiredObjectives: ["sell"],
  label: "Store A",
};
const plan = {
  _id: id<"coveragePlans">("plan-1"),
  assigneeProfileId: id<"profiles">("self"),
  localMonth: "2026-10",
  version: 1,
  status: "draft",
  contentRevision: 1,
  effectiveFrom: Date.parse("2026-09-30T16:00:00Z"),
  effectiveTo: Date.parse("2026-10-31T16:00:00Z"),
  preparedBy: "seller",
  territoryIds: [id<"territories">("territory-1")],
};
const detail = (status = "draft") =>
  ({
    plan: { ...plan, status },
    outlets: [
      {
        ...visitOutlet,
        planId: plan._id,
        frequency: "weekly",
        preferredWeekdays: [1],
        customLocalDates: [],
        priority: 1,
      },
    ],
    slots: [
      {
        ...toggleVisit([], visitOutlet, "2026-10-05")[0]!,
        approvedSnapshot:
          status === "approved"
            ? {
                outletName: "Frozen Store",
                outletCode: "OLD",
                routeCode: "OLD-R",
                territoryCode: "OLD-T",
                sequence: 3,
                territoryId: visitOutlet.territoryId,
                routeId: visitOutlet.routeId,
              }
            : undefined,
      },
    ],
    assignments: [],
    warnings: [
      "No weekly routine for position; no routine inferred",
      "2026-10-05: 1 planned stores; position standard 5/day",
    ],
  }) as unknown as React.ComponentProps<typeof PlanEditor>["detail"];
const render = (node: React.ReactNode) => {
  state.index = 0;
  return renderToStaticMarkup(node);
};
beforeEach(() => {
  state.calls = [];
  state.selected = "";
  state.editorError = "";
  state.values = {
    "lib/capabilities:currentPermissions": {
      role: "manager",
      capabilities: [
        "mcp.read",
        "mcp.plan",
        "people.read",
        "outlet.read",
        "route.read",
      ],
      scopeUnitIds: ["unit-1"],
    },
    "domains/profiles:current": {
      _id: id<"profiles">("self"),
      name: "Manager",
    },
    "people/queries:list": {
      page: [
        {
          _id: id<"profiles">("seller"),
          name: "Sales One",
          orgUnitId: "unit-1",
          status: "active",
          email: "s@example.test",
        },
        {
          _id: id<"profiles">("outsider"),
          name: "Other Region",
          orgUnitId: "unit-2",
          status: "active",
          email: "o@example.test",
        },
      ],
      isDone: true,
    },
    "coverage/plans:list": [plan],
    "coverage/plans:detail": detail(),
    "coverage/routines:listForPosition": {
      warning: "No weekly routine for position; no routine inferred",
      templates: [],
    },
    "territories/queries:list": { page: [], isDone: true },
    "outlets/queries:list": { page: [], isDone: true },
  };
});

describe("standalone coverage planner", () => {
  it("selects only scoped active people; sales selects self and skips people list", () => {
    const manager = render(createElement(CoveragePlanner));
    expect(manager).toContain("Sales One");
    expect(manager).not.toContain("Other Region");
    state.values["lib/capabilities:currentPermissions"] = {
      role: "sales",
      capabilities: ["mcp.read", "mcp.plan", "outlet.read"],
      scopeUnitIds: ["unit-1"],
    };
    const sales = render(createElement(CoveragePlanner));
    expect(sales).toContain('value="self"');
    expect(sales).not.toContain("Sales One");
    expect(
      state.calls.filter((c) => c.name === "people/queries:list").at(-1)?.args,
    ).toBe("skip");
  });
  it("shows the returned reason to the salesperson without exposing preparer auth ID", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00+08:00"));
    try {
      state.selected = plan._id;
      state.values["lib/capabilities:currentPermissions"] = {
        role: "sales",
        capabilities: ["mcp.read", "mcp.plan"],
        scopeUnitIds: ["unit-1"],
      };
      state.values["coverage/discovery:attribution"] = {
        preparedByName: "Sales One",
        latestReturnReason: "Fix missing route",
      };
      const html = render(createElement(CoveragePlanner));
      expect(html).toContain("Returned for changes");
      expect(html).toContain("Fix missing route");
      expect(html).toContain("History tab");
      expect(html).not.toContain("prepared by seller");
    } finally {
      vi.useRealTimers();
    }
  });
  it("renders versions and denied permissions without writes or leaking denied queries", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      role: "analyst",
      capabilities: ["mcp.read"],
      scopeUnitIds: [],
    };
    const html = render(createElement(CoveragePlanner));
    expect(html).toContain("v1");
    expect(html).toMatch(/New plan<\/button>/);
    expect(html).toMatch(/disabled=""[^>]*>New plan/);
    state.values["lib/capabilities:currentPermissions"] = {
      role: "viewer",
      capabilities: [],
      scopeUnitIds: [],
    };
    expect(render(createElement(CoveragePlanner))).toContain(
      "MCP read access required",
    );
    expect(
      state.calls.filter((c) => c.name === "coverage/plans:list").at(-1)?.args,
    ).toBe("skip");
  });
  it("shows advisory routine and daily call warnings with draft controls", () => {
    const html = render(
      createElement(PlanEditor, { detail: detail(), canPlan: true }),
    );
    expect(html).toContain("No weekly routine");
    expect(html).toContain("position standard 5/day");
    expect(html).toContain("Apply weekly routine");
    expect(html).toContain("Submit for approval");
    expect(html).toContain("Save outlet cadence");
    expect(html).toContain("Save dated slots");
  });
  it("renders submitted and approved plans read-only; approved rows use frozen snapshots", () => {
    const submitted = render(
      createElement(PlanEditor, { detail: detail("submitted"), canPlan: true }),
    );
    expect(submitted).not.toContain("Submit for approval");
    expect(submitted).not.toContain("Save dated slots");
    expect(submitted).toContain("Read-only submitted");
    const approved = render(
      createElement(PlanEditor, { detail: detail("approved"), canPlan: true }),
    );
    expect(approved).toContain("OLD Frozen Store · OLD-R");
    expect(approved).toContain("OLD-R #3");
    expect(approved).toContain("OLD-T / OLD-R");
    expect(approved).toContain("Read-only approved");
    expect(approved).toContain('disabled=""');
    const denied = render(
      createElement(PlanEditor, { detail: detail(), canPlan: false }),
    );
    expect(denied).not.toContain("Save outlet cadence");
    expect(denied).not.toContain("Submit for approval");
  });
  it("renders mutation error inline", () => {
    state.editorError = "Server denied outlet scope";
    expect(
      render(createElement(PlanEditor, { detail: detail(), canPlan: true })),
    ).toContain('role="alert"');
    expect(
      render(createElement(PlanEditor, { detail: detail(), canPlan: true })),
    ).toContain("Server denied outlet scope");
  });
});

describe("planner mutation payloads", () => {
  it("toggles a stable visit key, preserves kind, sequence and route in saveSlots", async () => {
    const first = toggleVisit([], visitOutlet, "2026-10-05");
    expect(first[0]).toMatchObject({
      slotKey: "visit:outlet-1:2026-10-05",
      kind: "outlet_visit",
      outletId: "outlet-1",
      routeId: "route-1",
      sequence: 1,
      expectedDurationMinutes: 30,
    });
    const second = toggleVisit(first, visitOutlet, "2026-10-06");
    const activity = {
      slotKey: "activity:2026-10-05:1",
      serviceDate: "2026-10-05",
      kind: "non_visit" as const,
      activityKind: "Work-With",
      namedTruckRef: "TRUCK-01",
      sequence: 1,
      expectedDurationMinutes: 0,
      requiredObjectives: [],
      intents: [],
    };
    const save = vi.fn(async () => null);
    await saveCoverageSlots(plan._id, [...second, activity], save);
    expect(save).toHaveBeenCalledWith({
      planId: plan._id,
      slots: [...second, activity],
    });
    expect(toggleVisit(second, visitOutlet, "2026-10-05")).toEqual([second[1]]);
    const grid = render(
      createElement(CoverageGrid, {
        month: "2026-10",
        outlets: [visitOutlet],
        slots: second,
        onChange: vi.fn(),
        readOnly: true,
      }),
    );
    expect(grid).toContain("Store A");
    expect(grid).toContain("2026-10-31");
  });
  it("sends complete outlet cadence values to saveOutlets", async () => {
    const save = vi.fn(async () => null);
    const outlets = [
      {
        outletId: visitOutlet.outletId,
        territoryId: visitOutlet.territoryId,
        routeId: visitOutlet.routeId,
        frequency: "biweekly" as const,
        anchorLocalDate: "2026-10-05",
        weekOrdinal: 2,
        preferredWeekdays: [1 as const, 3 as const],
        customLocalDates: ["2026-10-07"],
        priority: 2,
        expectedDurationMinutes: 40,
        sequence: 3,
        requiredObjectives: ["merchandise"],
        visitWindow: "AM",
      },
    ];
    await saveCoverageOutlets(plan._id, outlets, save);
    expect(save).toHaveBeenCalledWith({ planId: plan._id, outlets });
  });
  it("sends exclusive Manila midnight assignment instants with reason", async () => {
    const save = vi.fn(async () => null);
    await saveCoverageAssignment(
      plan._id,
      "2026-10-05",
      "2026-11-01",
      "Updated period",
      save,
    );
    expect(save).toHaveBeenCalledWith({
      planId: plan._id,
      effectiveFrom: Date.parse("2026-10-04T16:00:00Z"),
      effectiveTo: Date.parse("2026-10-31T16:00:00Z"),
      reason: "Updated period",
    });
    expect(() =>
      saveCoverageAssignment(
        plan._id,
        "2026-10-05",
        "2026-10-05",
        "oops",
        save,
      ),
    ).toThrow(/follow/);
    expect(() =>
      saveCoverageAssignment(plan._id, "2026-10-05", "2026-10-06", " ", save),
    ).toThrow(/reason/);
  });
  it("submits the selected plan and requires a nonblank reason to revise", async () => {
    const submit = vi.fn(async () => null);
    await submitCoveragePlan(plan._id, submit);
    expect(submit).toHaveBeenCalledWith({ planId: plan._id });
    const revise = vi.fn(
      async () => ({ ...plan, status: "draft" }) as Doc<"coveragePlans">,
    );
    expect(() =>
      reviseCoveragePlan(plan._id, "2026-10-15", "  ", revise),
    ).toThrow(/reason/);
    expect(revise).not.toHaveBeenCalled();
    await reviseCoveragePlan(plan._id, "2026-10-15", " New route ", revise);
    expect(revise).toHaveBeenCalledWith({
      planId: plan._id,
      effectiveFromDate: "2026-10-15",
      reason: "New route",
    });
  });
});
