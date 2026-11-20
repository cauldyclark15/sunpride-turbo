import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CustomerFrequencyEditor,
  VisitFrequencyPicker,
} from "./visit-frequency";
import { CustomerListView, customerColumns } from "./customer-list";
import { indexReference, type CustomerRow } from "./model";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  nodes: [] as { type: unknown; props: Record<string, unknown> }[],
  mutate: vi.fn(),
  list: null as Record<string, unknown> | null,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = state.cursor++;
      if (!(i in state.values))
        state.values[i] = typeof initial === "function" ? initial() : initial;
      return [
        state.values[i],
        (next: unknown) => {
          state.values[i] =
            typeof next === "function" ? next(state.values[i]) : next;
        },
      ];
    },
  };
});
vi.mock("../../lib/api", () => ({
  mutate: (...args: unknown[]) => state.mutate(...args),
  useApi: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock("../list-page/list-page", () => ({
  PAGE_SIZE: 50,
  ListPage: (props: Record<string, unknown>) => {
    state.list = props;
    return null;
  },
}));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const wrap =
    (fn: typeof actual.jsx) =>
    (type: React.ElementType, props: Record<string, unknown>, key: string) => {
      state.nodes.push({ type, props });
      return fn(type, props, key);
    };
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      state.nodes.push({
        type: args[0],
        props: args[1] as Record<string, unknown>,
      });
      return actual.jsxDEV(...args);
    },
  };
});
function render(element: React.ReactElement) {
  state.cursor = 0;
  state.nodes = [];
  return renderToStaticMarkup(element);
}
const editor = (
  extra: Partial<Parameters<typeof CustomerFrequencyEditor>[0]> = {},
) =>
  createElement(CustomerFrequencyEditor, {
    customerIds: ["one", "two"],
    canManage: true,
    initialValue: "4 times a month",
    ...extra,
  });
const node = (type: string, label?: string) =>
  state.nodes.find(
    (n) => n.type === type && (!label || n.props.children === label),
  )!.props;
beforeEach(() => {
  state.values = [];
  state.mutate.mockReset();
  state.mutate.mockResolvedValue({ updated: 2 });
  state.list = null;
});

it("offers the requested plain choices and an exact monthly count", () => {
  const html = render(
    createElement(VisitFrequencyPicker, {
      value: "4 times a month",
      onChange: vi.fn(),
    }),
  );
  for (const label of [
    "Weekly",
    "Every 2 weeks",
    "Monthly",
    "N times a month",
    "Required visits per month",
  ])
    expect(html).toContain(label);
  expect(html).toContain('value="4"');
  expect(html).toContain('min="1" max="31"');
});
it("saves the selected customers together and shows success only after the reply", async () => {
  render(editor());
  await (
    node("button", "Save visit frequency").onClick as () => Promise<void>
  )();
  expect(state.mutate.mock.calls[0]?.slice(0, 2)).toEqual([
    "/api/v1/customers/visit-frequency",
    { customerIds: ["one", "two"], visitFrequency: "4 times a month" },
  ]);
  expect(render(editor())).toContain("Visit frequency saved for 2 customers.");
});
it("refuses an invalid monthly count before sending", async () => {
  render(editor({ initialValue: "0 times a month" }));
  await (
    node("button", "Save visit frequency").onClick as () => Promise<void>
  )();
  expect(state.mutate).not.toHaveBeenCalled();
  expect(render(editor())).toContain("1–31");
});
it("keeps the error visible without claiming a successful save", async () => {
  state.mutate.mockRejectedValue(
    new Error("This customer is outside your area."),
  );
  render(editor());
  await (
    node("button", "Save visit frequency").onClick as () => Promise<void>
  )();
  const html = render(editor());
  expect(html).toContain("This customer is outside your area.");
  expect(html).not.toContain("Visit frequency saved");
});
it("read-only users see the requirement without any editing controls", () => {
  const html = render(editor({ canManage: false, summary: "4 visits/month" }));
  expect(html).toContain("4 visits/month");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("Save visit frequency");
});
it("Customers bulk action passes exactly the ticked customers and is permission-gated", () => {
  const rows = [{ id: "one" }, { id: "two" }] as CustomerRow[];
  const props = {
    index: indexReference([]),
    rows,
    total: 2,
    page: 1,
    q: "",
    status: null,
    filters: {},
    canAdd: false,
    onSearch: vi.fn(),
    onPage: vi.fn(),
    onAdd: vi.fn(),
    onStatus: vi.fn(),
    onFilter: vi.fn(),
    customerHref: () => "/customers",
  };
  render(
    createElement(CustomerListView, { ...props, canManageFrequency: true }),
  );
  const actions = state.list!.bulkActions as {
    label: string;
    run: (rows: CustomerRow[]) => void;
  }[];
  expect(actions[0]?.label).toBe("Set visit frequency");
  actions[0]!.run([rows[1]!]);
  render(
    createElement(CustomerListView, { ...props, canManageFrequency: true }),
  );
  const panel = state.nodes.find((n) => n.type === CustomerFrequencyEditor);
  expect(panel?.props.customerIds).toEqual(["two"]);
  render(createElement(CustomerListView, props));
  expect(state.list!.bulkActions).toEqual([]);
  expect(state.nodes.some((n) => n.type === CustomerFrequencyEditor)).toBe(
    false,
  );
});
it("the list and export show exact monthly visits separately from weekly cadence", () => {
  const column = customerColumns(indexReference([])).find(
    (c) => c.key === "visitFrequency",
  )!;
  expect(
    column.text!({
      visitFrequencyDays: 7,
      visitFrequencyPerMonth: 4,
    } as CustomerRow),
  ).toBe("4 visits/month");
  expect(column.text!({ visitFrequencyDays: 7 } as CustomerRow)).toBe(
    "Weekly · 4–5 visits/month",
  );
  expect(column.text!({} as CustomerRow)).toBe("Not set");
});
