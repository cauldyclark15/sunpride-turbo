import React, { createElement, type ChangeEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { DevicesAdmin } from "./devices-admin";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  canManage: true,
  query: vi.fn(),
  inputs: {} as Record<string, (event: ChangeEvent<HTMLInputElement>) => void>,
  status: undefined as undefined | ((value: string) => void),
  next: undefined as undefined | (() => void),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = initial;
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] =
          typeof next === "function" ? next(state.values[index]) : next;
      },
    ];
  },
}));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const wrap =
    (fn: typeof actual.jsx) =>
    (type: React.ElementType, props: Record<string, unknown>, key: string) => {
      if (type === "input" && props["aria-label"])
        state.inputs[String(props["aria-label"])] =
          props.onChange as (typeof state.inputs)[string];
      return fn(type, props, key);
    };
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      if (args[0] === "input") {
        const props = args[1] as Record<string, unknown>;
        if (props["aria-label"])
          state.inputs[String(props["aria-label"])] =
            props.onChange as (typeof state.inputs)[string];
      }
      return actual.jsxDEV(...args);
    },
  };
});
vi.mock("./master-data/api", async (original) => ({
  ...(await original<typeof import("./master-data/api")>()),
  useQuery: (path: string, args: unknown) => {
    state.query(path, args);
    if (args === "skip") return undefined;
    if (path === "org/permissions")
      return { capabilities: state.canManage ? ["admin.manage"] : [] };
    if (path === "people/devices/list")
      return {
        page: [],
        isDone: false,
        continueCursor: "next-phone-page",
      };
    return undefined;
  },
  useMutation: () => vi.fn(),
}));
vi.mock("./integrity/fleet", () => ({ WaitingPhones: () => null }));
vi.mock("./org-admin", () => ({
  AdminSelectField: ({
    label,
    onChange,
  }: {
    label: string;
    onChange: (value: string) => void;
  }) => {
    state.status = onChange;
    return <select aria-label={label} />;
  },
}));
vi.mock("@heroui/react", () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}));
vi.mock("@sunpride/ui", () => ({
  Card: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <section aria-label={label}>{children}</section>
  ),
  DataTable: ({ empty }: { empty: React.ReactNode }) => <>{empty}</>,
  ListRow: () => null,
  Notice: ({ title }: { title: string }) => <p>{title}</p>,
  Pager: ({ onNext }: { onNext: () => void }) => {
    state.next = onNext;
    return null;
  },
  StatusPill: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WorkspaceIcon: () => null,
}));

function render() {
  state.cursor = 0;
  state.query.mockClear();
  state.inputs = {};
  return renderToStaticMarkup(createElement(DevicesAdmin));
}
function listArgs() {
  return state.query.mock.calls.find(
    ([path]) => path === "people/devices/list",
  )?.[1];
}
function type(label: string, value: string) {
  expect(state.inputs[label]).toBeTypeOf("function");
  state.inputs[label]!({ target: { value } } as ChangeEvent<HTMLInputElement>);
}
beforeEach(() => {
  state.values = [];
  state.canManage = true;
  state.status = undefined;
  state.next = undefined;
});

it("SP-0232 shows a labelled Person search without changing the initial phone list", () => {
  const html = render();
  expect(html).toContain('type="search" aria-label="Person"');
  expect(html).toContain('placeholder="Search by name"');
  expect(html).toContain('aria-label="Search phones"');
  expect(listArgs()).toEqual({
    paginationOpts: { numItems: 25, cursor: null },
  });
});

it("SP-0232 sends Person with the other filters, preserves it across pages and resets paging on edit or clear", () => {
  render();
  type("Search phones", "PHONE");
  state.status!("suspended");
  render();
  state.next!();
  render();
  expect(listArgs().paginationOpts.cursor).toBe("next-phone-page");

  type("Person", "  Ana Reyes  ");
  render();
  expect(listArgs()).toEqual({
    q: "PHONE",
    person: "Ana Reyes",
    status: "suspended",
    paginationOpts: { numItems: 25, cursor: null },
  });
  state.next!();
  render();
  expect(listArgs()).toMatchObject({
    person: "Ana Reyes",
    paginationOpts: { cursor: "next-phone-page" },
  });
  type("Person", "Ben");
  render();
  expect(listArgs()).toMatchObject({
    person: "Ben",
    paginationOpts: { cursor: null },
  });
  state.next!();
  render();
  type("Person", "");
  render();
  expect(listArgs()).toEqual({
    q: "PHONE",
    status: "suspended",
    paginationOpts: { numItems: 25, cursor: null },
  });
  type("Person", "   ");
  render();
  expect(listArgs()).not.toHaveProperty("person");
});

it("SP-0232 keeps phone queries and the Person control unavailable without administrator access", () => {
  state.canManage = false;
  const html = render();
  expect(html).toContain("Administrator access required");
  expect(html).not.toContain('aria-label="Person"');
  expect(listArgs()).toBe("skip");
});
