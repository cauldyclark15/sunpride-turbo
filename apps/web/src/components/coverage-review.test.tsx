import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "@sunpride/backend/data-model";
import {
  CoverageReview,
  coverageStatus,
  returnCoveragePlan,
  approveCoveragePlan,
  activateCoveragePlan,
} from "./coverage-review";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  writes: [] as { name: string; args: unknown }[],
  handlers: {} as Record<string, (...args: never[]) => unknown>,
  hooks: [] as unknown[],
  index: 0,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "people/queries:history")
      return (args as { profileId: string }).profileId === "manager"
        ? []
        : [{ effectiveFrom: 0 }];
    return state.values[name];
  },
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    return async (args: unknown) => {
      state.writes.push({ name, args });
      return name === "coverage/activation:activate"
        ? { count: 1, visitIds: ["visit-1"] }
        : {};
    };
  },
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.index++;
      if (!(index in state.hooks))
        state.hooks[index] =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      return [
        state.hooks[index],
        (value: unknown) => {
          state.hooks[index] =
            typeof value === "function"
              ? (value as (old: unknown) => unknown)(state.hooks[index])
              : value;
        },
      ];
    },
  };
});
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const capture = (type: unknown, props: Record<string, unknown>) => {
    if (type === "button" && props.onClick)
      state.handlers[String(props.children)] = props.onClick as (
        ...args: never[]
      ) => unknown;
    if (type === "input" && props.onChange && props["aria-label"])
      state.handlers[String(props["aria-label"])] = props.onChange as (
        ...args: never[]
      ) => unknown;
  };
  return {
    ...actual,
    jsx: (type: unknown, props: Record<string, unknown>, key?: string) => {
      capture(type, props);
      return actual.jsx(type as never, props, key);
    },
    jsxs: (type: unknown, props: Record<string, unknown>, key?: string) => {
      capture(type, props);
      return actual.jsxs(type as never, props, key);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (
      type: unknown,
      props: Record<string, unknown>,
      key: string | undefined,
      isStatic: boolean,
      source: unknown,
      self: unknown,
    ) => {
      if (type === "button" && props.onClick)
        state.handlers[String(props.children)] = props.onClick as (
          ...args: never[]
        ) => unknown;
      if (type === "input" && props.onChange && props["aria-label"])
        state.handlers[String(props["aria-label"])] = props.onChange as (
          ...args: never[]
        ) => unknown;
      return actual.jsxDEV(
        type as never,
        props,
        key,
        isStatic,
        source as never,
        self,
      );
    },
  };
});
const id = <T extends "profiles" | "coveragePlans" | "orgUnits">(
  value: string,
) => value as Id<T>;
const profile = {
  _id: id<"profiles">("manager"),
  name: "Manager",
  authSubject: "manager-subject",
};
const permissions = {
  role: "manager",
  capabilities: ["mcp.read", "mcp.approve", "people.read"],
  scopeUnitIds: [id<"orgUnits">("unit")],
};
const plan = {
  _id: id<"coveragePlans">("plan-1"),
  assigneeProfileId: id<"profiles">("seller"),
  localMonth: "2026-10",
  version: 2,
  status: "submitted",
  effectiveFrom: Date.parse("2026-09-30T16:00:00Z"),
  preparedBy: "seller-subject",
  preparedAt: 1,
  submittedBy: "seller-subject",
  submittedAt: 2,
};
const slot = {
  _id: "slot-1",
  serviceDate: "2026-10-03",
  kind: "outlet_visit",
  outletId: "outlet-1",
  sequence: 3,
  requiredObjectives: ["Stock check"],
  approvedSnapshot: {
    outletCode: "OUT-1",
    outletName: "Frozen Market",
    customerId: "customer-1",
    routeCode: "R-1",
    sequence: 3,
  },
};
const render = (
  mode: "review" | "visits" | "history" = "review",
  who = profile,
  grants = permissions,
) => {
  state.index = 0;
  state.calls = [];
  state.handlers = {};
  return renderToStaticMarkup(
    createElement(CoverageReview, { mode, profile: who, permissions: grants }),
  );
};
beforeEach(() => {
  state.hooks = [];
  state.writes = [];
  state.values = {
    "people/queries:list": {
      page: [
        {
          _id: id<"profiles">("seller"),
          name: "Sales One",
          orgUnitId: id<"orgUnits">("unit"),
          status: "active",
        },
        {
          _id: id<"profiles">("other"),
          name: "Outsider",
          orgUnitId: id<"orgUnits">("outside"),
          status: "active",
        },
      ],
      isDone: true,
    },
    "coverage/plans:list": [plan],
    "coverage/plans:detail": {
      plan,
      slots: [slot],
      outlets: [],
      assignments: [],
      warnings: ["Five-store target is advisory"],
    },
    "coverage/activation:plannedForMonth": [
      {
        _id: "visit-1",
        serviceDate: "2026-10-03",
        approvedSnapshot: slot.approvedSnapshot,
        planVersion: 2,
        status: "planned",
      },
    ],
    "coverage/history:list": {
      page: [
        {
          _id: "audit-1",
          action: "plan.returned",
          actorSubject: "manager-subject",
          createdAt: 10,
          reason: "Missing objective",
          before: { status: "submitted" },
          after: { status: "draft" },
          affectedEntity: "coveragePlan",
          approvalSignatureRef: "signed:v1",
        },
      ],
      isDone: false,
      continueCursor: "next",
    },
  };
});

describe("coverage review", () => {
  it("lists submitted plans for scoped people and opens dated slot warnings and frozen attribution", () => {
    state.hooks[0] = "2026-10";
    const queue = render();
    expect(queue).toContain("Sales One");
    expect(queue).not.toContain("Outsider");
    expect(
      state.calls
        .filter((c) => c.name === "coverage/plans:list")
        .map((c) => c.args),
    ).toEqual(["skip", { assigneeProfileId: "seller", localMonth: "2026-10" }]);
    state.hooks[1] = id<"profiles">("seller");
    state.hooks[2] = plan._id;
    const opened = render();
    expect(opened).toContain("Frozen Market");
    expect(opened).toContain("customer-1");
    expect(opened).toContain("R-1");
    expect(opened).toContain("Five-store target");
    expect(opened).toContain("seller-subject");
    expect(opened).toContain("version 2");
    expect(
      state.calls.find((c) => c.name === "coverage/plans:detail")?.args,
    ).toEqual({ planId: "plan-1" });
  });
  it("inspects submitted slots against service-date outlet, customer, and route projections", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = id<"profiles">("seller");
    state.hooks[2] = plan._id;
    state.values["coverage/plans:detail"] = {
      plan,
      slots: [{ ...slot, approvedSnapshot: undefined }],
      warnings: [],
    };
    state.values["outlets/queries:detail"] = {
      outlet: { code: "LIVE", name: "Current Store" },
      customerLink: { customerId: "linked-customer" },
      assignment: { routeId: "route-1", sequence: 4 },
    };
    state.values["territories/routes:detail"] = { route: { code: "ROUTE-1" } };
    const html = render("review", profile, {
      ...permissions,
      capabilities: [...permissions.capabilities, "outlet.read", "route.read"],
    });
    expect(html).toContain("LIVE Current Store");
    expect(html).toContain("linked-customer");
    expect(html).toContain("ROUTE-1");
    expect(html).toContain("stop 4");
    expect(
      state.calls.find((c) => c.name === "outlets/queries:detail")?.args,
    ).toEqual({
      outletId: "outlet-1",
      asOf: Date.parse("2026-10-02T16:00:00Z"),
    });
  });
  it("validates return reason and sends trimmed return/approve payloads", async () => {
    const run = vi.fn(async () => ({}));
    expect(() => returnCoveragePlan(plan._id, " ", run)).toThrow(
      "Return reason required",
    );
    await returnCoveragePlan(plan._id, "  needs route  ", run);
    await approveCoveragePlan(plan._id, run);
    expect(run.mock.calls).toEqual([
      [{ planId: "plan-1", reason: "needs route" }],
      [{ planId: "plan-1" }],
    ]);
    state.hooks[0] = "2026-10";
    state.hooks[1] = id<"profiles">("seller");
    state.hooks[2] = plan._id;
    state.hooks[4] = "Fix objective";
    render();
    await state.handlers["Return with reason"]!();
    await state.handlers["Approve"]!();
    expect(state.writes).toEqual([
      {
        name: "coverage/plans:returnPlan",
        args: { planId: "plan-1", reason: "Fix objective" },
      },
      { name: "coverage/plans:approve", args: { planId: "plan-1" } },
    ]);
  });
  it.each(["preparedBy", "submittedBy", "assigneeProfileId"] as const)(
    "disables independent approval for %s",
    (field) => {
      state.hooks[0] = "2026-10";
      state.hooks[1] = id<"profiles">("seller");
      state.hooks[2] = plan._id;
      state.values["coverage/plans:detail"] = {
        plan: {
          ...plan,
          [field]:
            field === "assigneeProfileId" ? profile._id : profile.authSubject,
        },
        slots: [slot],
        warnings: [],
      };
      const html = render();
      expect(html).toContain("independent reviewer");
      expect(html).toMatch(/disabled=""[^>]*>Approve/);
      expect(html).toMatch(/disabled=""[^>]*>Return with reason/);
    },
  );
  it("generates visits and displays stable IDs/count on repeated activation", async () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = id<"profiles">("seller");
    state.hooks[2] = plan._id;
    state.values["coverage/plans:detail"] = {
      plan: { ...plan, status: "active", effectiveFrom: 0 },
      slots: [slot],
      warnings: [],
    };
    render();
    await state.handlers["Generate / reconcile planned visits"]!();
    await vi.waitFor(() => expect(state.hooks[5]).toBe(false));
    const html = render();
    expect(html).toContain("1 planned visit(s): visit-1");
    expect(html).toContain("Frozen Market");
    expect(html).toContain("v2");
    expect(state.hooks[5]).toBe(false);
    await state.handlers["Generate / reconcile planned visits"]!();
    expect(state.writes).toEqual([
      { name: "coverage/activation:activate", args: { planId: "plan-1" } },
      { name: "coverage/activation:activate", args: { planId: "plan-1" } },
    ]);
    expect(
      await activateCoveragePlan(
        plan._id,
        vi.fn(async () => ({ count: 1, visitIds: ["visit-1"] })),
      ),
    ).toEqual({ count: 1, visitIds: ["visit-1"] });
  });
  it("marks future approval distinctly, disallows premature generation, and shows automatic activation", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = id<"profiles">("seller");
    state.hooks[2] = plan._id;
    state.values["coverage/plans:detail"] = {
      plan: {
        ...plan,
        status: "approved",
        effectiveFrom: Date.now() + 86_400_000,
      },
      slots: [slot],
      warnings: [],
    };
    const html = render();
    expect(html).toContain("Approved · future");
    expect(html).toContain("not yet effective");
    expect(html).toMatch(
      /disabled=""[^>]*>Generate \/ reconcile planned visits/,
    );
    expect(coverageStatus({ status: "superseded", effectiveFrom: 0 })).toBe(
      "Superseded",
    );
  });
  it("paginates history with actor, reason, before/after and version provenance", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = id<"profiles">("seller");
    state.hooks[2] = plan._id;
    let html = render("history");
    expect(html).toContain("Missing objective");
    expect(html).toContain("manager-subject");
    expect(html).toContain("signed:v1");
    expect(html).toContain("submitted");
    expect(html).toContain("draft");
    state.handlers["More history"]!();
    html = render("history");
    expect(
      state.calls.find((c) => c.name === "coverage/history:list")?.args,
    ).toEqual({
      planId: "plan-1",
      paginationOpts: { numItems: 20, cursor: "next" },
    });
    expect(html).toContain("Missing objective");
  });
  it("restricts sales to own planned visits and skips people and denied reads", () => {
    const sales = {
      _id: id<"profiles">("seller"),
      name: "Seller",
      authSubject: "seller-subject",
    };
    const grants = {
      role: "sales",
      capabilities: ["mcp.read", "mcp.plan"],
      scopeUnitIds: [id<"orgUnits">("unit")],
    };
    state.hooks[0] = "2026-10";
    expect(render("visits", sales, grants)).toContain("visit-1");
    expect(
      state.calls.find((c) => c.name === "people/queries:list")?.args,
    ).toBe("skip");
    expect(
      state.calls.find((c) => c.name === "coverage/activation:plannedForMonth")
        ?.args,
    ).toEqual({ assigneeProfileId: "seller", localMonth: "2026-10" });
    render("review", sales, grants);
    expect(state.calls.some((c) => c.name === "coverage/plans:list")).toBe(
      false,
    );
  });
});
