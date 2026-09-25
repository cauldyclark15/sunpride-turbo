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
  signatureLabel,
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
    if (
      name === "coverage/history:list" &&
      (args as { planId: string }).planId === "plan-2"
    )
      return {
        page: [
          {
            _id: "audit-2",
            action: "plan.approved",
            createdAt: 20,
            reason: "Second version",
          },
        ],
        isDone: true,
        continueCursor: "",
      };
    if (
      name === "coverage/discovery:attribution" &&
      (args as { planId: string }).planId === "plan-2"
    )
      return {
        preparedByName: "Sales One",
        eventsActorNames: { "audit-2": "Manager" },
      };
    if (
      name === "coverage/plans:detail" &&
      (args as { planId: string }).planId === "plan-2"
    )
      return {
        plan: { ...plan, _id: id<"coveragePlans">("plan-2"), version: 1 },
        slots: [],
        warnings: [],
      };
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
    "coverage/discovery:list": {
      page: [
        {
          planId: plan._id,
          assigneeProfileId: plan.assigneeProfileId,
          assigneeName: "Sales One",
          localMonth: "2026-10",
          version: 2,
          status: "submitted",
        },
      ],
      isDone: true,
      continueCursor: "",
    },
    "coverage/discovery:attribution": {
      preparedByName: "Sales One",
      submittedByName: "Sales One",
      approvedByName: "Manager",
      latestReturnReason: "Missing objective",
      eventsActorNames: { "audit-1": "Manager" },
    },
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
          actorSubject: "issuer|manager-subject",
          createdAt: 10,
          reason: "Missing objective",
          planVersion: 2,
          before: {
            status: "submitted",
            reviewer: "issuer|manager-subject",
            detail: { owner: "issuer|orphan" },
          },
          after: {
            status: "draft",
            reviewer: "issuer|manager-subject",
            detail: { owner: "issuer|orphan" },
          },
          affectedEntity: "coveragePlan",
          approvalSignatureRef:
            "plan-1:1:https://issuer.example|approver:1790360100000:feedface0123456789",
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
      state.calls.find((c) => c.name === "coverage/discovery:list")?.args,
    ).toEqual({
      localMonth: "2026-10",
      status: "submitted",
      paginationOpts: { numItems: 20, cursor: null },
    });
    state.hooks[1] = plan._id;
    const opened = render();
    expect(opened).toContain("Frozen Market");
    expect(opened).toContain("customer-1");
    expect(opened).toContain("R-1");
    expect(opened).toContain("Five-store target");
    expect(opened).toContain("Prepared by Sales One");
    expect(opened).toContain("version 2");
    expect(opened).not.toContain("seller-subject");
    expect(
      state.calls.find((c) => c.name === "coverage/plans:detail")?.args,
    ).toEqual({ planId: plan._id });
    expect(
      state.calls.find((c) => c.name === "outlets/queries:detail")?.args,
    ).toBe("skip");
    expect(
      state.calls.find((c) => c.name === "territories/routes:detail")?.args,
    ).toBe("skip");
  });
  it("inspects submitted slots against service-date outlet, customer, and route projections", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = plan._id;
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
    expect(
      state.calls.find((c) => c.name === "territories/routes:detail")?.args,
    ).toEqual({
      routeId: "route-1",
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
      [{ planId: plan._id, reason: "needs route" }],
      [{ planId: plan._id }],
    ]);
    state.hooks[0] = "2026-10";
    state.hooks[1] = plan._id;
    state.hooks[5] = "Fix objective";
    render();
    await state.handlers["Return with reason"]!();
    await vi.waitFor(() => expect(state.hooks[6]).toBe(false));
    await state.handlers["Approve"]!();
    await vi.waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes).toEqual([
      {
        name: "coverage/plans:returnPlan",
        args: { planId: plan._id, reason: "Fix objective" },
      },
      { name: "coverage/plans:approve", args: { planId: plan._id } },
    ]);
  });
  it.each(["preparedBy", "submittedBy", "assigneeProfileId"] as const)(
    "disables independent approval for %s",
    (field) => {
      state.hooks[0] = "2026-10";
      state.hooks[1] = plan._id;
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
  it("uses scoped discovery without people.read and shows attributed names", () => {
    state.hooks[0] = "2026-10";
    expect(render()).toContain("Sales One");
    expect(
      state.calls.some(
        (c) =>
          c.name.startsWith("people/queries") ||
          c.name === "coverage/plans:list",
      ),
    ).toBe(false);
    expect(
      state.calls.find((c) => c.name === "coverage/discovery:list")?.args,
    ).toEqual({
      localMonth: "2026-10",
      status: "submitted",
      paginationOpts: { numItems: 20, cursor: null },
    });
    state.hooks[1] = plan._id;
    const html = render();
    expect(html).toContain("Prepared by Sales One");
    expect(html).toContain("Five-store target");
    expect(html).not.toContain("seller-subject");
  });
  it("selects a version and renders that plan's own action timeline", () => {
    state.hooks[0] = "2026-10";
    render("history");
    const select = Object.values(state.handlers).find((fn) =>
      String(fn).includes("setSelected(p.planId)"),
    );
    expect(select).toBeDefined();
    select!();
    const html = render("history");
    expect(
      state.calls.find((c) => c.name === "coverage/history:list")?.args,
    ).toEqual({
      planId: plan._id,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(html).toContain("plan.returned");
    expect(html).toContain("Missing objective");
    expect(html).toContain("Manager");
    expect(html).not.toContain("manager-subject");
    state.values["coverage/discovery:list"] = {
      page: [
        {
          planId: "plan-2",
          assigneeProfileId: plan.assigneeProfileId,
          assigneeName: "Sales One",
          localMonth: "2026-10",
          version: 1,
          status: "approved",
        },
        {
          planId: plan._id,
          assigneeProfileId: plan.assigneeProfileId,
          assigneeName: "Sales One",
          localMonth: "2026-10",
          version: 2,
          status: "submitted",
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    state.hooks[1] = id<"coveragePlans">("plan-2");
    const oldVersion = render("history");
    expect(oldVersion).toContain("plan.approved");
    expect(oldVersion).toContain("Second version");
    expect(oldVersion).not.toContain("Missing objective");
    expect(
      state.calls.find((c) => c.name === "coverage/history:list")?.args,
    ).toMatchObject({ planId: "plan-2" });
  });
  it("resets selection and cursor when month changes", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = plan._id;
    state.hooks[3] = "old-cursor";
    render("history");
    state.handlers["Coverage month"]!({
      target: { value: "2026-11" },
    } as never);
    expect(state.hooks[0]).toBe("2026-11");
    expect(state.hooks[1]).toBe(null);
    expect(state.hooks[3]).toBe(null);
  });
  it("restricts sales to own visit picker and doesn't subscribe to people", () => {
    state.hooks[0] = "2026-10";
    const html = render(
      "visits",
      {
        _id: id<"profiles">("seller"),
        name: "Seller",
        authSubject: "seller-subject",
      },
      {
        role: "sales",
        capabilities: ["mcp.read", "mcp.plan"],
        scopeUnitIds: [id<"orgUnits">("unit")],
      },
    );
    expect(html).toContain("visit-1");
    expect(state.calls.some((c) => c.name.startsWith("people/queries"))).toBe(
      false,
    );
  });
  it("validates trimmed return payloads", async () => {
    const run = vi.fn(async () => ({}));
    expect(() => returnCoveragePlan(plan._id, " ", run)).toThrow();
    await returnCoveragePlan(plan._id, " fix route ", run);
    await approveCoveragePlan(plan._id, run);
    expect(run.mock.calls).toEqual([
      [{ planId: plan._id, reason: "fix route" }],
      [{ planId: plan._id }],
    ]);
  });
  it("generates visits and displays stable IDs/count on repeated activation", async () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = plan._id;
    state.values["coverage/plans:detail"] = {
      plan: { ...plan, status: "active", effectiveFrom: 0 },
      slots: [slot],
      warnings: [],
    };
    render();
    await state.handlers["Generate / reconcile planned visits"]!();
    await vi.waitFor(() => expect(state.hooks[6]).toBe(false));
    const html = render();
    expect(html).toContain("1 planned visit(s): visit-1");
    expect(html).toContain("Frozen Market");
    expect(html).toContain("v2");
    expect(state.hooks[6]).toBe(false);
    await state.handlers["Generate / reconcile planned visits"]!();
    await vi.waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes).toEqual([
      { name: "coverage/activation:activate", args: { planId: plan._id } },
      { name: "coverage/activation:activate", args: { planId: plan._id } },
    ]);
    expect(
      await activateCoveragePlan(
        plan._id,
        vi.fn(async () => ({ count: 1, visitIds: ["visit-1"] })),
      ),
    ).toEqual({
      count: 1,
      visitIds: ["visit-1"],
    });
  });
  it("marks future approval distinctly, disallows premature generation, and shows automatic activation", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = plan._id;
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
    expect(html).toContain("scheduled activation will generate visits");
    expect(html).toMatch(
      /disabled=""[^>]*>Generate \/ reconcile planned visits/,
    );
    expect(coverageStatus({ status: "superseded", effectiveFrom: 0 })).toBe(
      "Superseded",
    );
  });
  it("paginates history with actor, reason, before/after and version provenance", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = plan._id;
    let html = render("history");
    expect(html).toContain("Missing objective");
    expect(html).toContain("Manager");
    expect(html).toContain("Version 2");
    expect(html).toContain("Signed version: v1 · feedface0123");
    expect(html).not.toContain("issuer.example");
    expect(html).toContain("Before → After");
    expect(html).toContain("status: submitted → draft");
    expect(html).toContain("reviewer: Manager → Manager");
    expect(html).toContain("Former user");
    expect(html).not.toContain("issuer|manager-subject");
    expect(html).not.toContain("issuer|orphan");
    state.handlers["More history"]!();
    html = render("history");
    expect(
      state.calls.find((c) => c.name === "coverage/history:list")?.args,
    ).toEqual({
      planId: plan._id,
      paginationOpts: { numItems: 20, cursor: "next" },
    });
    expect(html).toContain("Missing objective");
  });
  it("falls back to Former user when an audit actor has no attribution", () => {
    state.hooks[0] = "2026-10";
    state.hooks[1] = plan._id;
    state.values["coverage/discovery:attribution"] = {
      preparedByName: "Sales One",
      eventsActorNames: {},
    };
    const html = render("history");
    expect(html).toContain("plan.returned</strong> · Former user");
    expect(html).toContain("reviewer: Former user → Former user");
    expect(html).not.toContain("issuer|manager-subject");
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
    state.values["coverage/discovery:list"] = {
      page: [
        {
          planId: plan._id,
          assigneeProfileId: sales._id,
          assigneeName: "Seller",
          localMonth: "2026-10",
          version: 2,
          status: "active",
        },
        {
          planId: id<"coveragePlans">("other-plan"),
          assigneeProfileId: id<"profiles">("other"),
          assigneeName: "Outsider",
          localMonth: "2026-10",
          version: 1,
          status: "active",
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    const visits = render("visits", sales, grants);
    expect(visits).toContain("visit-1");
    expect(visits).toContain("Seller");
    expect(visits).not.toContain("Outsider");
    expect(
      state.calls.find((c) => c.name === "coverage/activation:plannedForMonth")
        ?.args,
    ).toEqual({
      assigneeProfileId: sales._id,
      localMonth: "2026-10",
    });
    expect(state.calls.some((c) => c.name.startsWith("people/queries"))).toBe(
      false,
    );
    expect(render("review", sales, grants)).toContain("MCP access required");
    expect(
      state.calls.find((c) => c.name === "coverage/discovery:list")?.args,
    ).toBe("skip");
    expect(state.calls.some((c) => c.name === "coverage/plans:detail")).toBe(
      false,
    );
    expect(render("visits", sales, { ...grants, capabilities: [] })).toContain(
      "MCP access required",
    );
    expect(
      state.calls.find((c) => c.name === "coverage/activation:plannedForMonth"),
    ).toBeUndefined();
  });
  it("retains activation helper", async () => {
    expect(
      await activateCoveragePlan(plan._id, async () => ({ count: 1 })),
    ).toEqual({ count: 1 });
    expect(coverageStatus({ status: "superseded", effectiveFrom: 0 })).toBe(
      "Superseded",
    );
  });
});

describe("approval signature label", () => {
  it("shows version and hash, never the approver token", () => {
    const label = signatureLabel(
      "vn7plan:1:https://example.convex.site|k17subject:1790360100000:abcdef0123456789",
    );
    expect(label).toBe("v1 · abcdef012345");
    expect(label).not.toMatch(/\||convex\.site|Former user/);
  });

  it("falls back for an unexpected shape", () => {
    expect(signatureLabel("opaque")).toBe("signed");
  });
});
