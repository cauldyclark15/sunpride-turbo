import React, { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  PhoneCustodyActions,
  LOST_PHONE_BIR_NOTE,
} from "./phone-custody-actions";
import type { Device } from "./master-data/model";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  form: undefined as
    undefined | ((event: FormEvent<HTMLFormElement>) => Promise<void>),
  buttons: {} as Record<string, () => void>,
  select: undefined as undefined | ((value: string) => void),
  search: undefined as undefined | ((value: string) => void),
  query: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values))
      state.values[index] = typeof initial === "function" ? initial() : initial;
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
      if (type === "form") state.form = props.onSubmit as typeof state.form;
      return fn(type, props, key);
    };
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      if (args[0] === "form")
        state.form = (args[1] as Record<string, unknown>)
          .onSubmit as typeof state.form;
      return actual.jsxDEV(...args);
    },
  };
});
vi.mock("./master-data/api", async (original) => ({
  ...(await original<typeof import("./master-data/api")>()),
  useQuery: (path: string, args: unknown) => {
    state.query(path, args);
    return args === "skip"
      ? undefined
      : {
          page: [
            {
              _id: "old",
              name: "Old person",
              email: "old@example.test",
              orgUnitId: "branch",
            },
            {
              _id: "next",
              name: "Replacement person",
              email: "next@example.test",
              orgUnitId: "branch",
            },
          ],
          isDone: false,
          continueCursor: "page-two",
        };
  },
  useMutation: (path: string) => (body: unknown) => state.mutation(path, body),
}));
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    onPress,
    type,
    isDisabled,
  }: {
    children: string;
    onPress?: () => void;
    type?: "submit";
    isDisabled?: boolean;
  }) => {
    if (onPress) state.buttons[children] = onPress;
    return (
      <button type={type} disabled={isDisabled}>
        {children}
      </button>
    );
  },
}));
vi.mock("@sunpride/ui", () => ({
  Pager: ({
    label,
    canNext,
    onNext,
  }: {
    label: string;
    canNext: boolean;
    onNext: () => void;
  }) => {
    state.buttons["Next people"] = onNext;
    return (
      <button aria-label={label} disabled={!canNext}>
        Next
      </button>
    );
  },
}));
vi.mock("./org-admin", () => ({
  AdminSelectField: ({
    label,
    options,
    onChange,
  }: {
    label: string;
    options: { id: string; label: string }[];
    onChange: (value: string) => void;
  }) => {
    state.select = onChange;
    return (
      <select aria-label={label}>
        {options.map((o) => (
          <option key={o.id}>{o.label}</option>
        ))}
      </select>
    );
  },
}));
vi.mock("./master-data/setup-health", () => ({
  SetupSearch: ({
    label,
    onChange,
  }: {
    label: string;
    onChange: (value: string) => void;
  }) => {
    state.search = onChange;
    return <input aria-label={label} />;
  },
}));
const device: Device = {
  deviceId: "phone",
  profileId: "old",
  inventoryTag: "Company phone",
  employeeName: "Old person",
  status: "active",
  platform: "android",
  model: "Phone",
  lastSeenAt: null,
  statusAt: null,
  offlineLeaseExpiresAt: null,
};
function render(value = device) {
  state.cursor = 0;
  state.buttons = {};
  state.form = undefined;
  return renderToStaticMarkup(
    createElement(PhoneCustodyActions, { device: value }),
  );
}
async function submit() {
  expect(state.form).toBeTypeOf("function");
  await state.form!({ preventDefault: () => {} } as FormEvent<HTMLFormElement>);
}
beforeEach(() => {
  state.values = [];
  state.query.mockReset();
  state.mutation.mockReset();
  state.mutation.mockResolvedValue(null);
});

it("SP-0221 gives the phone to a searched, paged replacement and explains fresh sign-in", async () => {
  let html = render();
  expect(html).toContain("Give to another person");
  expect(html).toContain("Mark as lost");
  state.buttons["Give to another person"]!();
  html = render();
  expect(html).toContain("Setup &gt; People");
  expect(html).toContain("Replacement person");
  expect(html).not.toContain("old@example.test");
  state.select!("next");
  render();
  await submit();
  expect(state.mutation).toHaveBeenCalledWith("people/devices/reassign", {
    deviceId: "phone",
    profileId: "next",
  });
  expect(render()).toContain("download their own data");
});
it("SP-0221 paginates and searches replacement people without silently selecting one", async () => {
  render();
  state.buttons["Give to another person"]!();
  render();
  state.buttons["Next people"]!();
  render();
  expect(state.query).toHaveBeenLastCalledWith("people/list", {
    status: "active",
    q: "",
    paginationOpts: { numItems: 25, cursor: "page-two" },
  });
  state.search!("Replacement");
  render();
  expect(state.query).toHaveBeenLastCalledWith("people/list", {
    status: "active",
    q: "Replacement",
    paginationOpts: { numItems: 25, cursor: null },
  });
  await submit();
  expect(state.mutation).not.toHaveBeenCalled();
  expect(render()).toContain("Choose the replacement person");
});
it("SP-0221 confirms loss, shows the BIR reminder, and sends the lost-phone command", async () => {
  render();
  state.buttons["Mark as lost"]!();
  const html = render();
  expect(html).toContain(LOST_PHONE_BIR_NOTE);
  expect(html).toContain("does not remotely erase the phone");
  await submit();
  expect(state.mutation).toHaveBeenCalledWith("people/devices/lost", {
    deviceId: "phone",
  });
  expect(render()).toContain("until an administrator registers it again");
});
it("SP-0221 only offers register-again for a lost phone and does not restore an old sign-in", async () => {
  const lost: Device = { ...device, status: "revoked", lost: true };
  expect(render(lost)).toContain("Lost phone");
  expect(state.buttons["Give to another person"]).toBeUndefined();
  expect(state.buttons["Mark as lost"]).toBeUndefined();
  state.buttons["Register again"]!();
  expect(render(lost)).toContain("old sign-in will not be restored");
  await submit();
  expect(state.mutation).toHaveBeenCalledWith("people/devices/reregister", {
    deviceId: "phone",
  });
});
it("SP-0221 registers a recovered phone directly to a replacement person", async () => {
  const lost: Device = { ...device, status: "revoked", lost: true };
  render(lost);
  state.buttons["Register again"]!();
  render(lost);
  state.select!("next");
  render(lost);
  await submit();
  expect(state.mutation).toHaveBeenCalledWith("people/devices/reregister", {
    deviceId: "phone",
    profileId: "next",
  });
});
it("SP-0221 keeps the form open and shows a refused office action", async () => {
  render();
  state.buttons["Mark as lost"]!();
  render();
  state.mutation.mockRejectedValueOnce(new Error("Your access changed"));
  await submit();
  expect(render()).toContain("Your access changed");
  expect(state.form).toBeTypeOf("function");
});
