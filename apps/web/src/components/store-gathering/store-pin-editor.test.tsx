import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { LocationCoverage, type LocationRow } from "./location-coverage";
import { StorePinEditor } from "./store-pin-editor";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  nodes: [] as { type: unknown; props: Record<string, unknown> }[],
  map: null as null | {
    onMove: (pin: { latitude: number; longitude: number }) => void;
  },
  canEdit: false,
  mutate: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
  useRef: (initial: unknown) => {
    const i = state.refCursor++;
    return (state.refs[i] ??= { current: initial });
  },
}));
vi.mock("next/dynamic", () => ({
  default: () => (props: typeof state.map) => {
    state.map = props;
    return null;
  },
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => state.canEdit }),
}));
vi.mock("../../lib/api", () => ({
  mutate: (...args: unknown[]) => state.mutate(...args),
  apiFetch: vi.fn(),
  useApi: () => ({
    data: {
      total: 2,
      located: 1,
      truncated: false,
      rows: [
        {
          id: "one",
          name: "Missing store",
          address: "Cebu",
          code: "A",
          located: false,
        },
        {
          id: "two",
          name: "Tagged store",
          address: "Cebu",
          code: "B",
          located: true,
          latitude: 10,
          longitude: 123,
        },
      ],
    },
  }),
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
const missing: LocationRow = {
  id: "one",
  name: "Missing store",
  address: "Cebu",
  code: "A",
  located: false,
};
function render(el: React.ReactElement) {
  state.cursor = 0;
  state.refCursor = 0;
  state.nodes = [];
  return renderToStaticMarkup(el);
}
const editor = () =>
  createElement(StorePinEditor, { store: missing, onClose: state.close });
function button(label: string) {
  return state.nodes.find(
    (n) => n.type === "button" && n.props.children === label,
  )!.props;
}
beforeEach(() => {
  state.values = [];
  state.refs = [];
  state.canEdit = false;
  state.map = null;
  state.mutate.mockReset();
  state.mutate.mockResolvedValue({});
  state.close.mockReset();
});
it("only office pin editors get Set location and Move pin for missing and existing stores", () => {
  const readonly = render(createElement(LocationCoverage));
  expect(readonly).toContain("Location not tagged yet");
  expect(readonly).not.toContain(">Set location<");
  expect(readonly).not.toContain(">Move pin<");
  state.canEdit = true;
  const office = render(createElement(LocationCoverage));
  expect(office).toContain(">Set location<");
  expect(office).toContain(">Move pin<");
});
it("no default fabricated pin is saved: map selection is required, then the real chosen point is sent", async () => {
  render(editor());
  expect(button("Save location").disabled).toBe(true);
  state.map!.onMove({ latitude: 10.33, longitude: 123.91 });
  render(editor());
  expect(button("Save location").disabled).toBe(false);
  await (button("Save location").onClick as () => Promise<void>)();
  expect(state.mutate).toHaveBeenCalledWith(
    "/api/v1/masters/stores/location",
    { outletId: "one", latitude: 10.33, longitude: 123.91 },
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  );
  expect(state.close).toHaveBeenCalledOnce();
});
it("an uncertain send retains the point and retries with the same request key", async () => {
  render(editor());
  state.map!.onMove({ latitude: 10.33, longitude: 123.91 });
  render(editor());
  state.mutate.mockRejectedValueOnce(new Error("offline"));
  await (button("Save location").onClick as () => Promise<void>)();
  expect(state.close).not.toHaveBeenCalled();
  expect(render(editor())).toContain("Your pin is still here");
  await (button("Save location").onClick as () => Promise<void>)();
  expect(state.mutate.mock.calls[0]?.[2].idempotencyKey).toBe(
    state.mutate.mock.calls[1]?.[2].idempotencyKey,
  );
  expect(state.close).toHaveBeenCalledOnce();
});
it("same-frame duplicate taps submit only once", async () => {
  render(editor());
  state.map!.onMove({ latitude: 10.33, longitude: 123.91 });
  render(editor());
  let done!: () => void;
  state.mutate.mockReturnValue(
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  const save = button("Save location").onClick as () => Promise<void>;
  const a = save();
  const b = save();
  expect(state.mutate).toHaveBeenCalledOnce();
  done();
  await Promise.all([a, b]);
});
