import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { WAITING_PHONE_INVALIDATE, WaitingPhones } from "./fleet";

const state = vi.hoisted(() => ({
  submit: undefined as undefined | ((e: FormEvent<HTMLFormElement>) => void),
  mutate: vi.fn(),
}));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const wrap =
    (fn: typeof actual.jsx) =>
    (type: React.ElementType, props: Record<string, unknown>, key: string) => {
      if (type === "form") state.submit = props.onSubmit as typeof state.submit;
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
        state.submit = (args[1] as Record<string, unknown>)
          .onSubmit as typeof state.submit;
      return actual.jsxDEV(...args);
    },
  };
});
beforeEach(() => {
  state.submit = undefined;
  state.mutate.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: (c: string) => c === "phones.manage" }),
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({
    data: {
      devices: [],
      assets: [],
      units: [],
      people: [{ id: "p1", name: "SAMPLE seller", org_unit_id: "u" }],
      providers: [],
      truncated: false,
      waiting: [
        {
          id: "w1",
          personId: "p1",
          person: "SAMPLE seller",
          app: "field-android",
          phoneCode: "AB12 CD34 EF56 7890",
          replaces: "Old sales phone",
          requestedAt: Date.UTC(2026, 10, 14, 0, 30),
          lastSeenAt: Date.UTC(2026, 10, 14, 0, 31),
        },
      ],
    },
  }),
  useLive: vi.fn(),
  mutate: (...args: unknown[]) => state.mutate(...args),
  apiFetch: vi.fn(),
}));

it("SP-0174 Setup > Phones lists phones waiting to be registered with Register and Reject", () => {
  const html = renderToStaticMarkup(createElement(WaitingPhones));
  expect(html).toContain("Phones waiting to be registered");
  expect(html).toContain("SAMPLE seller · Field app");
  expect(html).toContain("AB12 CD34 EF56 7890");
  expect(html).toContain("Asked Nov 14");
  expect(html).toContain("Replaces Old sales phone");
  expect(html).toContain("Phones guide");
  expect(html).toContain(
    "No asset tag, replacement code or old-phone work check is needed.",
  );
  expect(html).toContain(
    "Controlled handover in Fleet &amp; integrity is optional.",
  );
  expect(html).toContain(">Register<");
  expect(html).toContain(">Reject<");
  expect(html).toContain(
    "Phone not listed? Register with the phone&#x27;s code",
  );
});

it("keeps waiting phone codes on one line with the full value on hover and Copy", () => {
  const html = renderToStaticMarkup(createElement(WaitingPhones));
  expect(html).toContain('title="AB12 CD34 EF56 7890"');
  expect(html).toContain('aria-label="Copy phone code AB12 CD34 EF56 7890"');
  expect(html).toContain("min-w-0 flex-1 truncate font-mono text-sm");
  expect(html).toContain("min-w-0 flex-1 basis-64");
});

it.each(["", "   "])(
  "SP-0234 copied-code registration leaves blank phone labels (%j) for automatic naming",
  (tag) => {
    renderToStaticMarkup(createElement(WaitingPhones));
    expect(state.submit).toBeTypeOf("function");
    const form = new FormData();
    form.set("person", "p1");
    form.set("app", "field-android");
    form.set("tag", tag);
    form.set("code", "cGhv bmU=\n");
    vi.stubGlobal("FormData", function () {
      return form;
    });
    state.submit!({
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>);
    expect(state.mutate).toHaveBeenCalledWith(
      "/api/v1/people/devices/register",
      {
        profileId: "p1",
        app: "field-android",
        inventoryTag: undefined,
        phoneCode: "cGhvbmU=",
      },
      expect.objectContaining({ invalidate: WAITING_PHONE_INVALIDATE }),
    );
  },
);

it.each(["3CB8 F416 075F A4E6", "3cb8f416075fa4e6"])(
  "SP-0248 the manual form sends the short phone code (%s), never asks for a long key",
  (code) => {
    const html = renderToStaticMarkup(createElement(WaitingPhones));
    expect(html).toContain("tap Check again");
    expect(html).toContain("short 16-character");
    expect(html).not.toContain("press Copy code");
    const form = new FormData();
    form.set("person", "p1");
    form.set("app", "field-android");
    form.set("code", code);
    vi.stubGlobal("FormData", function () {
      return form;
    });
    state.submit!({
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>);
    expect(state.mutate).toHaveBeenCalledWith(
      "/api/v1/people/devices/register",
      {
        profileId: "p1",
        app: "field-android",
        inventoryTag: undefined,
        phoneCode: code.replace(/\s+/g, ""),
      },
      expect.objectContaining({ invalidate: WAITING_PHONE_INVALIDATE }),
    );
  },
);

it("SP-0178 Register refreshes Setup > Phones (the setup device list), not only the waiting list", () => {
  expect(WAITING_PHONE_INVALIDATE).toEqual(
    expect.arrayContaining([["integrity"], ["setup"]]),
  );
});
