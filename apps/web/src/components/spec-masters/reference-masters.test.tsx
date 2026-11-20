import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  ReferenceMasters,
  ReferenceChangeLog,
  ReferenceForm,
  referenceSaveBody,
} from "./reference-masters";
import { CustomerGroupsAdmin } from "../customer-groups-admin";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  national: true,
  submit: undefined as
    undefined | ((e: FormEvent<HTMLFormElement>) => Promise<void>),
  buttons: [] as { children: unknown; onClick?: () => void }[],
  mutate: vi.fn(),
  groupSave: vi.fn(),
  apiError: false,
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
vi.mock("../master-data/api", () => ({
  useQuery: (path: string) =>
    path === "org/permissions"
      ? {
          national: state.national,
          capabilities: ["territory.read", "territory.manage"],
        }
      : { page: [], isDone: true, continueCursor: "" },
  useMutation: () => state.groupSave,
}));
vi.mock("../master-data/location", () => ({ useSetupParam: () => null }));
const channel = {
  id: "channel",
  code: "099",
  name: "SAMPLE channel",
  salesOrgCode: "1000",
  updatedAt: "2026-11-20T00:00:00.000Z",
};
vi.mock("../../lib/api", () => ({
  mutate: (...args: unknown[]) => state.mutate(...args),
  useLive: vi.fn(),
  useApi: (key: unknown[] | null) => ({
    error: state.apiError ? new Error("Could not load shared lists") : null,
    data: !key
      ? undefined
      : key[1] === "channels"
        ? { rows: [channel], salesOrgs: [{ code: "1000", name: "SFI" }] }
        : key[1] === "reference-log"
          ? {
              rows: [
                {
                  id: "log",
                  kind: "place",
                  label: "SAMPLE Barangay",
                  actorName: "SAMPLE Admin",
                  reason: "Boundary realignment",
                  createdAt: "2026-11-20T00:00:00.000Z",
                  before: { name: "Old place", parentCode: "0101001000" },
                  after: { name: "New place", parentCode: "0201001000" },
                },
              ],
              next: "next",
            }
          : { rows: [], hasMore: true },
  }),
}));
function capture(type: unknown, props: Record<string, unknown>) {
  if (type === "form") state.submit = props.onSubmit as typeof state.submit;
  if (type === "button")
    state.buttons.push(props as (typeof state.buttons)[number]);
}
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const wrap =
    (fn: typeof actual.jsx) =>
    (type: React.ElementType, props: Record<string, unknown>, key: string) => {
      capture(type, props);
      return fn(type, props, key);
    };
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      capture(args[0], args[1] as Record<string, unknown>);
      return actual.jsxDEV(...args);
    },
  };
});
function render(node: React.ReactNode) {
  state.cursor = 0;
  state.buttons = [];
  return renderToStaticMarkup(node);
}
beforeEach(() => {
  state.values = [];
  state.cursor = 0;
  state.national = true;
  state.apiError = false;
  state.submit = undefined;
  state.mutate.mockReset().mockResolvedValue({ id: "saved" });
  state.groupSave.mockReset().mockResolvedValue("saved");
});
afterEach(() => vi.unstubAllGlobals());
const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [key, value] of Object.entries(values)) f.set(key, value);
  return f;
};

describe("SP-0230 field reference maintenance", () => {
  it("offers customer groups, actual distribution channels, places and change log from Field masters", () => {
    const html = render(<ReferenceMasters other={<p>Existing masters</p>} />);
    for (const label of [
      "Customer groups",
      "Channels",
      "Places",
      "Change log",
      "Other field masters",
    ])
      expect(html).toContain(label);
    state.values[0] = "channels";
    const channels = render(<ReferenceMasters other={null} />);
    expect(channels).toContain("SAMPLE channel");
    expect(channels).toContain(
      "distribution channels used on the customer form",
    );
  });
  it("shows realignment and territory re-mapping guidance instead of editing an unrelated polygon", () => {
    state.values[0] = "places";
    const html = render(<ReferenceMasters other={null} />);
    expect(html).toContain("PSGC code stays the same");
    expect(html).toContain('href="/admin?section=territories"');
    expect(html).toContain("Search places by name or PSGC code");
    expect(html).toContain("Places pages");
  });
  it("denies national maintenance to regional administrators and displays load failures", () => {
    state.values[0] = "channels";
    state.national = false;
    expect(render(<ReferenceMasters other={null} />)).toContain(
      "national administrator",
    );
    state.national = true;
    state.apiError = true;
    expect(render(<ReferenceMasters other={null} />)).toContain(
      "Could not load shared lists",
    );
  });
  it("displays what, why, who and when, with both sides and visible paging", () => {
    const html = render(<ReferenceChangeLog />);
    for (const label of [
      "SAMPLE Admin",
      "Boundary realignment",
      "Old place",
      "New place",
      "Before",
      "After",
      "Change log pages",
      "Parent place",
    ])
      expect(html).toContain(label);
    expect(html).not.toContain("parentCode");
  });
  it("submits the actual channel form with the entered reason and stable idempotent intent", async () => {
    const saved = vi.fn();
    render(<ReferenceForm mode="channel" current={channel} onSaved={saved} />);
    const data = form({
      name: "SAMPLE renamed",
      reason: "Correct the channel name",
    });
    vi.stubGlobal("FormData", function () {
      return data;
    });
    await state.submit!({
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>);
    expect(state.mutate).toHaveBeenCalledWith(
      "/api/v1/masters/reference/channel-save",
      {
        id: "channel",
        name: "SAMPLE renamed",
        reason: "Correct the channel name",
        baseUpdatedAt: channel.updatedAt,
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(saved).toHaveBeenCalledOnce();
  });
  it("keeps entered place parents, codes, concurrency version and reason in the wire command", () => {
    const current = {
      code: "0101001001",
      name: "SAMPLE place",
      parentCode: "0101001000",
      parentName: "Old parent",
      updatedAt: channel.updatedAt,
    };
    const html = render(
      <ReferenceForm mode="barangay" current={current} onSaved={vi.fn()} />,
    );
    expect(html).toContain('name="parentCode"');
    expect(html).toContain("Old parent");
    expect(html).toContain("Reason for this change");
    expect(
      referenceSaveBody(
        "barangay",
        form({
          name: "New name",
          parentCode: "0201001000",
          reason: "Boundary moved",
        }),
        current,
      ),
    ).toEqual({
      kind: "barangay",
      code: current.code,
      create: false,
      baseUpdatedAt: current.updatedAt,
      name: "New name",
      parentCode: "0201001000",
      reason: "Boundary moved",
    });
    expect(
      referenceSaveBody(
        "channel",
        form({
          code: "009",
          salesOrgCode: "1000",
          name: "New channel",
          reason: "Additional channel",
        }),
      ),
    ).toMatchObject({
      code: "009",
      salesOrgCode: "1000",
      reason: "Additional channel",
    });
  });
  it("shows save errors and retains the retry key after an uncertain send", async () => {
    state.mutate.mockRejectedValue(new Error("Please reload this channel"));
    const saved = vi.fn();
    render(<ReferenceForm mode="channel" current={channel} onSaved={saved} />);
    const data = form({ name: "SAMPLE renamed", reason: "Correct name" });
    vi.stubGlobal("FormData", function () {
      return data;
    });
    const event = {
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>;
    await state.submit!(event);
    expect(
      render(
        <ReferenceForm mode="channel" current={channel} onSaved={saved} />,
      ),
    ).toContain("Please reload this channel");
    await state.submit!(event);
    expect(state.mutate.mock.calls[0]![2].idempotencyKey).toBe(
      state.mutate.mock.calls[1]![2].idempotencyKey,
    );
    expect(saved).not.toHaveBeenCalled();
  });
  it("requires the administrator's actual group reason instead of a canned Setup message", async () => {
    render(createElement(CustomerGroupsAdmin));
    state.buttons.find((b) => b.children === "Add customer group")!.onClick!();
    const html = render(createElement(CustomerGroupsAdmin));
    expect(html).toContain("Reason for this change");
    const data = form({
      code: "SAMPLE",
      name: "SAMPLE Group",
      reason: "New chain agreed by office",
    });
    vi.stubGlobal("FormData", function () {
      return data;
    });
    await state.submit!({
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>);
    expect(state.groupSave).toHaveBeenCalledWith({
      code: "SAMPLE",
      name: "SAMPLE Group",
      reason: "New chain agreed by office",
    });
  });
});
