import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "@sunpride/backend/data-model";
import {
  OutletAssignments,
  performAssignmentAction,
} from "./outlet-assignments";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  calls: [] as { name: string; args: unknown }[],
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    if (name === "lib/capabilities:currentPermissions")
      return { capabilities: state.permissions };
    return undefined;
  },
  useMutation: () => vi.fn(),
}));
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    isDisabled,
  }: {
    children: React.ReactNode;
    isDisabled?: boolean;
  }) => createElement("button", { disabled: isDisabled }, children),
}));
const id = <T extends "outlets" | "routes" | "territories">(s: string) =>
  s as Id<T>;
const form = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] ?? null }) as Pick<FormData, "get">;
const actions = () => ({
  assign: vi.fn(async () => null),
  batchAssign: vi.fn(async () => null),
  reorder: vi.fn(async () => null),
});

describe("outlet assignment screen", () => {
  beforeEach(() => {
    state.permissions = [];
    state.calls = [];
  });
  it("skips every denied data query and does not show write controls", () => {
    const html = renderToStaticMarkup(createElement(OutletAssignments));
    expect(html).toContain("Outlet read access required");
    expect(
      state.calls
        .filter((c) => c.name !== "lib/capabilities:currentPermissions")
        .every((c) => c.args === "skip"),
    ).toBe(true);
    expect(html).not.toContain("Bulk reassign selection");
  });
  it("passes reason and Manila midnight to assign, bulk and atomic reorder", async () => {
    const m = actions();
    const data = form({
      territoryId: id<"territories">("t"),
      routeId: id<"routes">("r"),
      effectiveDate: "2099-01-02",
      sequence: "4",
      reason: "coverage move",
    });
    const a = id<"outlets">("a"),
      b = id<"outlets">("b");
    const ms = Date.parse("2099-01-01T16:00:00Z");
    await performAssignmentAction("assign", data, m, [a], []);
    expect(m.assign).toHaveBeenCalledWith({
      outletId: a,
      territoryId: "t",
      routeId: "r",
      sequence: 4,
      effectiveFrom: ms,
      reason: "coverage move",
    });
    await performAssignmentAction("bulk", data, m, [a, b], []);
    expect(m.batchAssign).toHaveBeenCalledWith({
      assignments: [
        { outletId: a, territoryId: "t", routeId: "r", sequence: 4 },
        { outletId: b, territoryId: "t", routeId: "r", sequence: 5 },
      ],
      effectiveFrom: ms,
      reason: "coverage move",
    });
    await performAssignmentAction("reorder", data, m, [], [b, a]);
    expect(m.reorder).toHaveBeenCalledWith({
      routeId: "r",
      outletIds: [b, a],
      effectiveFrom: ms,
      reason: "coverage move",
    });
  });
});
