import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "@sunpride/backend/data-model";
import { OutletAdmin, performOutletAction } from "./outlet-admin";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  selected: null as string | null,
  error: "",
  queries: [] as { name: string; args: unknown }[],
  nullIndex: 0,
  emptyIndex: 0,
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never);
    state.queries.push({ name, args });
    return state.values[name];
  },
  useMutation: () => vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === null) {
        state.nullIndex++;
        if (state.nullIndex === 1 && state.selected)
          return [state.selected, vi.fn()];
      }
      if (initial === "") {
        state.emptyIndex++;
        if (state.emptyIndex === 1 && state.error)
          return [state.error, vi.fn()];
      }
      return [
        typeof initial === "function" ? (initial as () => unknown)() : initial,
        vi.fn(),
      ];
    },
  };
});
const id = <T extends "outlets" | "outletPins" | "customers" | "orgUnits">(
  value: string,
) => value as Id<T>;
const outlet = {
  _id: id<"outlets">("outlet"),
  code: "SHOP-1",
  name: "Corner Store",
  status: "prospect",
  custodianOrgUnitId: id<"orgUnits">("east"),
} as Doc<"outlets">;
const pending = {
  _id: id<"outletPins">("pin"),
  outletId: outlet._id,
  status: "pending",
  latitude: 14.6,
  longitude: 121,
  radiusMeters: 75,
  source: "survey",
  proposedBy: "owner",
} as Doc<"outletPins">;
const actions = () => ({
  create: vi.fn(),
  edit: vi.fn(),
  link: vi.fn(),
  deactivate: vi.fn(),
  propose: vi.fn(),
  decide: vi.fn(),
});
const form = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] ?? null }) as Pick<FormData, "get">;
const render = () => {
  state.nullIndex = 0;
  state.emptyIndex = 0;
  return renderToStaticMarkup(createElement(OutletAdmin));
};
beforeEach(() => {
  state.selected = null;
  state.error = "";
  state.queries = [];
  state.values = {
    "lib/capabilities:currentPermissions": {
      capabilities: ["outlet.read", "outlet.manage", "outlet.verify"],
    },
    "domains/profiles:current": { authSubject: "owner" },
    "outlets/queries:list": {
      page: [outlet],
      isDone: true,
      continueCursor: "",
    },
    "outlets/queries:detail": { outlet, customerLink: null, pin: null },
    "outlets/queries:customerHistory": [],
    "outlets/queries:pinHistory": [pending],
    "org/queries:tree": [],
    "domains/masterData:customers": [],
  };
});

describe("Outlet admin (unmounted)", () => {
  it("renders paginated scoped outlet list and skips detail until selection", () => {
    const view = render();
    expect(view).toContain("Corner Store · SHOP-1");
    expect(view).toContain("Prospect");
    expect(view).toContain("Pending");
    expect(view).not.toContain("Page 1");
    expect(state.queries).toContainEqual({
      name: "outlets/queries:detail",
      args: "skip",
    });
  });
  it("omits the normal active status pill but keeps row actions", () => {
    state.values["outlets/queries:list"] = {
      page: [{ ...outlet, status: "active" }],
      isDone: true,
      continueCursor: "",
    };
    const row =
      render().match(/<ul aria-label="Outlet list"[^>]*>(.*?)<\/ul>/)?.[1] ??
      "";
    expect(row).toContain("Corner Store");
    expect(row).toContain("Open</button>");
    expect(row).not.toContain("Active</span>");
  });
  it("shows history, verification, and disables self-review controls", () => {
    state.selected = outlet._id;
    const view = render();
    expect(view).toContain("Customer history");
    expect(view).toContain("Unlinked prospect / site");
    expect(view).toContain("Verification");
    expect(view).toMatch(/disabled=""[^>]*>Approve/);
    expect(view).toMatch(/disabled=""[^>]*>Reject/);
    state.values["domains/profiles:current"] = { authSubject: "reviewer" };
    expect(render()).toMatch(/>Approve<\/button>/);
    expect(render()).not.toMatch(/disabled=""[^>]*>Approve/);
  });
  it("routes proposal and independent decision with required reasons", async () => {
    const calls = actions();
    await performOutletAction(
      "propose",
      form({
        latitude: "14.6",
        longitude: "121",
        source: "survey",
        reason: "  moved door  ",
      }),
      calls,
      outlet._id,
    );
    expect(calls.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        outletId: outlet._id,
        latitude: 14.6,
        longitude: 121,
        reason: "moved door",
      }),
    );
    await performOutletAction(
      "verified",
      form({ reason: "  photo agrees  " }),
      calls,
      outlet._id,
      pending._id,
    );
    expect(calls.decide).toHaveBeenCalledWith({
      pinId: pending._id,
      decision: "verified",
      reason: "photo agrees",
    });
    await performOutletAction(
      "rejected",
      form({ reason: "not entrance" }),
      calls,
      outlet._id,
      pending._id,
    );
    expect(calls.decide).toHaveBeenCalledWith({
      pinId: pending._id,
      decision: "rejected",
      reason: "not entrance",
    });
    await expect(
      performOutletAction(
        "verified",
        form({ reason: " " }),
        calls,
        outlet._id,
        pending._id,
      ),
    ).rejects.toThrow(/Reason required/);
  });
  it("shows errors inline and sends future Manila customer-link changes", async () => {
    state.error = "Requested scope is outside your organizational scope";
    expect(render()).toContain('role="alert"');
    expect(render()).toContain(
      "Requested scope is outside your organizational scope",
    );
    const calls = actions();
    await performOutletAction(
      "link",
      form({
        customerId: id<"customers">("shared"),
        effectiveDate: "2099-01-01",
        source: "local",
        reason: "linked",
      }),
      calls,
      outlet._id,
    );
    expect(calls.link).toHaveBeenCalledWith({
      outletId: outlet._id,
      customerId: id<"customers">("shared"),
      effectiveFrom: Date.parse("2098-12-31T16:00:00Z"),
      source: "local",
      reason: "linked",
    });
  });
});
