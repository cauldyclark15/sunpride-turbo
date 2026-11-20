import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { StoresPage } from "./stores";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  params: new URLSearchParams(),
  set: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (value: unknown) => [value, vi.fn()] };
});
vi.mock("../../../lib/auth", () => ({
  usePermissions: () => ({
    can: (capability: string) => state.permissions.includes(capability),
  }),
}));
vi.mock("../../../lib/api", () => ({
  useApi: () => ({ data: undefined }),
}));
vi.mock("../../store-gathering/tab", () => ({
  useWaitingCount: () => 0,
}));
vi.mock("./shared", () => ({
  buttonClass: "",
  usePageQuery: () => ({
    params: state.params,
    set: state.set,
    link: (href: string) => href,
    hrefWith: () => "/customers",
  }),
}));

type ListProps = {
  canAdd: boolean;
  onEdit?: (id: string) => void;
};
// Inspect the real page's list wiring without mounting its unrelated panels.
function listProps(node: ReactNode): ListProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = listProps(child);
      if (found) return found;
    }
    return;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const element = node as ReactElement<{
    children?: ReactNode;
    canAdd?: boolean;
    onEdit?: (id: string) => void;
  }>;
  if (
    typeof element.type === "function" &&
    element.type.name === "CustomersListTab"
  )
    return element.props as ListProps;
  return listProps(element.props.children);
}

beforeEach(() => {
  state.permissions = [];
  state.params = new URLSearchParams();
  state.set.mockReset();
});

it.each(["list", "new"])(
  "SP-0223 Sales Head can open one customer's visit requirement from the %s tab without general editing rights",
  (tab) => {
    state.permissions = ["outlet.frequency.manage"];
    state.params.set("tab", tab);
    const list = listProps(StoresPage());
    expect(list?.canAdd).toBe(false);
    expect(list?.onEdit).toBeTypeOf("function");
    list!.onEdit!("sample-customer");
    expect(state.set).toHaveBeenCalledWith({ edit: "sample-customer" });
  },
);
it("SP-0223 retains the office editor and does not offer it to read-only users", () => {
  state.permissions = ["outlet.manage"];
  expect(listProps(StoresPage())?.onEdit).toBeTypeOf("function");
  state.permissions = [];
  expect(listProps(StoresPage())?.onEdit).toBeUndefined();
});
