import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  passwordToggleLabel,
  togglePasswordVisibility,
} from "../../../../packages/ui/src/components/password-visibility";
import { LiveClient } from "../lib/api/live";
import { ApiProvider } from "../lib/api/provider";
import { ApiStore } from "../lib/api/store";
import { SESSION_KEY } from "../lib/auth/client";
import { SessionProvider } from "../lib/auth/session";
import { AuthScreen } from "./auth-screen";

const state = vi.hoisted(() => ({
  elements: [] as { type: string; props: Record<string, unknown> }[],
  replace: [] as string[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => state.replace.push(href),
    refresh: () => {},
    push: () => {},
  }),
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) =>
    createElement("img", { alt: String(props.alt ?? "") }),
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

function render(mode: "login" | "register") {
  state.elements = [];
  const store = new ApiStore();
  store.setData(SESSION_KEY, null); // signed out
  const live = new LiveClient(store, { url: () => "" });
  const markup = renderToStaticMarkup(
    createElement(
      ApiProvider,
      { store, live },
      createElement(
        SessionProvider,
        null,
        createElement(AuthScreen, { mode, next: "/issues" }),
      ),
    ),
  );
  return { markup, store };
}

function submitForm(values: Record<string, string>) {
  const form = state.elements.find((element) => element.type === "form");
  const onSubmit = form?.props.onSubmit as (
    event: FormEvent<HTMLFormElement>,
  ) => Promise<void>;
  vi.stubGlobal(
    "FormData",
    class {
      get(name: string) {
        return values[name] ?? null;
      }
    },
  );
  return onSubmit({
    preventDefault: () => {},
    currentTarget: {},
  } as unknown as FormEvent<HTMLFormElement>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  state.replace = [];
});

describe("AuthScreen on the Bun API", () => {
  it("renders the same sign-in screen with the eye button", () => {
    const { markup } = render("login");
    expect(markup).toContain("Sign in");
    expect(markup).toContain('type="password"');
    expect(markup).toContain('aria-label="Show password"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("Help for testers");
    const eye = state.elements.find(
      (element) => element.props["aria-label"] === "Show password",
    );
    expect(typeof eye?.props.onPress).toBe("function");
    // The eye flips the field to visible and its name to "Hide password".
    const visible = togglePasswordVisibility(false);
    expect(visible).toBe(true);
    expect(passwordToggleLabel(visible)).toBe("Hide password");
  });

  it("posts the trimmed, lower-cased credentials to /api/auth/sign-in", async () => {
    render("login");
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await submitForm({ email: "  Ana@Example.COM ", password: "secret-pass" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/sign-in");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "ana@example.com",
      password: "secret-pass",
    });
    expect(state.replace).toContain("/issues");
  });

  it("posts sign-up with the name to /api/auth/sign-up", async () => {
    render("register");
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await submitForm({
      name: " Ana Reyes ",
      email: "ana@example.com",
      password: "secret-pass",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/sign-up");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "ana@example.com",
      password: "secret-pass",
      name: "Ana Reyes",
    });
  });

  it("stays on the screen when the server refuses the sign-in", async () => {
    render("login");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "invalid_credentials",
                message: "Wrong email or password.",
                retryable: false,
              },
            }),
            { status: 401 },
          ),
      ),
    );
    await submitForm({ email: "ana@example.com", password: "wrong-pass" });
    expect(state.replace).toEqual([]);
  });
});
