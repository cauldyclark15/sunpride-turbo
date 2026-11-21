import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { APP_MODES_SAVED, AppModeChoice, BulkAppMode } from "./app-mode";

// Exercise the actual checkbox and Save callbacks without a browser/DOM substitute.
const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = state.index++;
    if (!(index in state.values)) state.values[index] = initial;
    return [
      state.values[index],
      (value: unknown) => {
        state.values[index] = value;
      },
    ];
  },
}));
type Props = Record<string, unknown>;
function nodes(node: ReactNode): Props[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  if (typeof node.type === "function")
    return nodes((node.type as (props: Props) => ReactNode)(node.props));
  return [node.props, ...nodes(node.props.children as ReactNode)];
}
function render(component: () => ReactNode) {
  state.index = 0;
  return nodes(component());
}
function pick(view: Props[], value: string) {
  const input = view.find((p) => p.type === "checkbox" && p.value === value)!;
  expect(input.disabled).toBe(false);
  (input.onChange as () => void)();
}
async function save(view: Props[], label: string) {
  const button = view.find((p) => p.children === label)!;
  expect(button.disabled).toBe(false);
  (button.onClick as () => void)();
  await Promise.resolve();
}
beforeEach(() => {
  state.values = [];
  state.index = 0;
});
const sales = { profileId: "a", name: "Ana", role: "sales", status: "active" };

it("bulk checkboxes send both chosen modes and report success", async () => {
  const write = vi.fn().mockResolvedValue(null),
    done = vi.fn();
  const component = () =>
    BulkAppMode({
      people: [sales],
      save: write,
      onDone: done,
      onCancel: vi.fn(),
    });
  pick(render(component), "visits");
  pick(render(component), "selling");
  await save(render(component), "Save");
  expect(write).toHaveBeenCalledWith({
    profileIds: ["a"],
    modes: ["visits", "selling"],
  });
  expect(done).toHaveBeenCalledWith(
    "1 person can now use Field visits, Truck selling.",
  );
});
it("the person editor replaces the set only when Save is clicked", async () => {
  const write = vi.fn().mockResolvedValue(null);
  const component = () =>
    AppModeChoice({
      target: { ...sales, appMode: "visits", appModes: ["visits", "selling"] },
      canManage: true,
      save: write,
    });
  pick(render(component), "visits");
  pick(render(component), "mapping");
  expect(write).not.toHaveBeenCalled();
  await save(render(component), "Save app modes");
  expect(write).toHaveBeenCalledWith({
    profileId: "a",
    modes: ["mapping", "selling"],
  });
  await Promise.resolve();
  expect(
    render(component).some(
      (p) => p.role === "status" && p.children === APP_MODES_SAVED,
    ),
  ).toBe(true);
});
it("empty selections and mixed-role Truck selling never save", async () => {
  const write = vi.fn(),
    component = () =>
      BulkAppMode({
        people: [sales, { ...sales, profileId: "b", role: "manager" }],
        save: write,
        onDone: vi.fn(),
        onCancel: vi.fn(),
      });
  let view = render(component);
  expect(view.find((p) => p.children === "Save")?.disabled).toBe(true);
  pick(view, "selling");
  view = render(component);
  expect(view.find((p) => p.children === "Save")?.disabled).toBe(true);
  (view.find((p) => p.children === "Save")!.onClick as () => void)();
  expect(write).not.toHaveBeenCalled();
});
it("a refused save keeps the selected modes and shows the reason", async () => {
  const component = () =>
    BulkAppMode({
      people: [sales],
      save: vi.fn().mockRejectedValue(new Error("Please try again")),
      onDone: vi.fn(),
      onCancel: vi.fn(),
    });
  pick(render(component), "visits");
  await save(render(component), "Save");
  const view = render(component);
  expect(view.find((p) => p.role === "alert")?.children).toBe(
    "Please try again",
  );
  expect(view.find((p) => p.value === "visits")?.checked).toBe(true);
});
