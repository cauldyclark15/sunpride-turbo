import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangePassword } from "./change-password";
import { AccountPage } from "./account-page";
import { APP_ROLES, canAccessWebModule } from "../../lib/module-access";
import {
  getWebNavigation,
  isWebModuleSlug,
  isWorkspaceSlug,
} from "../../config/navigation";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  elements: [] as { type: string; props: Record<string, unknown> }[],
  role: "viewer",
}));

// SSR interaction harness: retain only React local state between explicit renders,
// while keeping the real markup, PasswordInput and mutate/apiFetch transport.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.values))
        state.values[index] =
          typeof initial === "function" ? initial() : initial;
      return [
        state.values[index],
        (next: unknown) => {
          state.values[index] =
            typeof next === "function" ? next(state.values[index]) : next;
        },
      ];
    },
  };
});
vi.mock("../../lib/auth/session", () => ({
  useSession: () => ({
    profile: {
      id: "person",
      name: "Sample Person",
      email: "person@example.test",
      role: state.role,
      orgUnitId: "unit",
      active: true,
    },
  }),
}));
vi.mock("../../lib/api/hooks", () => ({
  useApi: () => ({ data: [{ id: "unit", name: "Sample Cebu team" }] }),
}));

function capture(type: unknown, props: Record<string, unknown>) {
  if (type === "form" || typeof props?.["aria-label"] === "string")
    state.elements.push({ type: String(type), props });
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

function render(account = false) {
  state.cursor = 0;
  state.elements = [];
  return renderToStaticMarkup(
    createElement(account ? AccountPage : ChangePassword),
  );
}
async function submit(
  confirmPassword = "new-password",
  currentPassword = "old-password",
) {
  const form = state.elements.find((element) => element.type === "form");
  const onSubmit = form?.props.onSubmit as (
    event: FormEvent<HTMLFormElement>,
  ) => Promise<void>;
  const values: Record<string, string> = {
    currentPassword,
    newPassword: "new-password",
    confirmPassword,
  };
  vi.stubGlobal(
    "FormData",
    class {
      get(key: string) {
        return values[key];
      }
    },
  );
  const reset = vi.fn();
  await onSubmit({
    preventDefault: () => {},
    currentTarget: { reset },
  } as unknown as FormEvent<HTMLFormElement>);
  return reset;
}
beforeEach(() => {
  state.values = [];
  state.role = "viewer";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Account change password", () => {
  it("renders three labelled hidden fields with the login screen's eye buttons", () => {
    const markup = render();
    expect(markup.match(/type="password"/g)).toHaveLength(3);
    expect(markup.match(/aria-label="Show password"/g)).toHaveLength(3);
    for (const name of ["currentPassword", "newPassword", "confirmPassword"])
      expect(markup).toContain(`name="${name}"`);
    expect(markup).toContain("Current password");
    expect(markup).toContain("Confirm new password");
    expect(markup).not.toContain('type="text"');
  });

  it("mismatched confirmation blocks the request and displays a plain-language error", async () => {
    render();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await submit("different-password");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(render()).toContain(
      "The new passwords do not match. Enter them again.",
    );
  });

  it("shows a 422 wrong_password response inline", async () => {
    render();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "wrong_password",
                message: "Your current password is incorrect.",
                retryable: false,
              },
            }),
            { status: 422 },
          ),
      ),
    );
    const reset = await submit();
    const markup = render();
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Your current password is incorrect.");
    expect(reset).not.toHaveBeenCalled();
  });

  it("posts current and new password only, clears fields and shows success", async () => {
    render();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reset = await submit();
    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/auth/change-password");
    expect(init.credentials).toBe("same-origin");
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
      "currentPassword",
      "newPassword",
    ]);
    expect(reset).toHaveBeenCalledOnce();
    expect(render()).toContain(
      "Password changed. Other devices were signed out.",
    );
  });

  it("renders the person's name, email, plain-language role and area", () => {
    const markup = render(true);
    for (const text of [
      "Sample Person",
      "person@example.test",
      "Viewer",
      "Sample Cebu team",
    ])
      expect(markup).toContain(text);
  });

  it.each(APP_ROLES)(
    "%s can open Account without adding it to the sidebar",
    (role) => {
      expect(canAccessWebModule("account", role)).toBe(true);
      expect(isWebModuleSlug("account")).toBe(true);
      expect(isWorkspaceSlug("account")).toBe(false); // static route, not the dynamic workspace guard
      const nav = getWebNavigation("/account", (slug) =>
        canAccessWebModule(slug, role),
      );
      expect(
        nav.navGroups
          .flatMap((group) => group.items)
          .some((item) => item.href === "/account"),
      ).toBe(false);
    },
  );

  it("does not grant Account to an unknown or absent role", () => {
    expect(canAccessWebModule("account", null)).toBe(false);
    expect(canAccessWebModule("account", "owner")).toBe(false);
  });
});
