import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORGOT_SENT_MESSAGE,
  ForgotPasswordScreen,
  ResetPasswordScreen,
  newPasswordProblem,
} from "./password-reset-screens";
import {
  EXPIRY_LINE,
  ResetPasswordDialog,
  canResetPassword,
  emailLine,
  type ResetResult,
} from "../people/reset-password";
import { ChangePassword } from "../account/change-password";
import { AuthScreen } from "../auth-screen";
import { toMe } from "../../lib/auth/types";

/** SP-0185 web: forgot page, reset page, forced change screen, People reset dialog. */

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  elements: [] as { type: unknown; props: Record<string, unknown> }[],
  replace: [] as string[],
}));

// SSR interaction harness: keep React local state between explicit renders and
// capture element props so handlers can be called directly.
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
    useRef: (initial: unknown) => ({ current: initial }),
  };
});
const capture = (type: unknown, props: Record<string, unknown>) => {
  state.elements.push({ type, props });
};
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => state.replace.push(href),
    refresh: () => {},
  }),
}));
vi.mock("next/image", () => ({
  default: (props: { alt: string }) => createElement("img", { alt: props.alt }),
}));
vi.mock("../../lib/auth/session", () => ({
  useSession: () => ({ status: "unauthenticated", profile: null }),
}));
vi.mock("../integrity/sso", () => ({ SsoButtons: () => null }));

function render(node: () => ReturnType<typeof createElement>) {
  state.cursor = 0;
  state.elements = [];
  return renderToStaticMarkup(node());
}
const textOf = (children: unknown): string =>
  Array.isArray(children)
    ? children.map(textOf).join("")
    : typeof children === "string"
      ? children
      : "";
function pressButton(label: string) {
  const button = state.elements.find(
    (e) =>
      typeof e.props.onPress === "function" &&
      textOf(e.props.children) === label,
  );
  if (!button) throw new Error(`No button ${label}`);
  (button.props.onPress as () => void)();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function submitForm(values: Record<string, string>) {
  const form = state.elements.find((e) => e.type === "form");
  vi.stubGlobal(
    "FormData",
    class {
      get(key: string) {
        return values[key];
      }
    },
  );
  await (
    form?.props.onSubmit as (e: FormEvent<HTMLFormElement>) => Promise<void>
  )({
    preventDefault: () => {},
    currentTarget: { reset: () => {} },
  } as unknown as FormEvent<HTMLFormElement>);
}
/** @returns the JSON bodies posted, answering each with `answer`. */
function stubFetch(answer: () => Response) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body ?? "null")) });
    return answer();
  });
  return calls;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  state.values = [];
  state.replace = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Forgot password page", () => {
  it("asks for an email and always shows the same sent message", async () => {
    expect(render(() => createElement(ForgotPasswordScreen))).toContain(
      'name="email"',
    );
    const calls = stubFetch(() => json(200, { ok: true }));
    await submitForm({ email: " Person@Example.test " });
    expect(calls).toEqual([
      {
        url: "/api/auth/forgot-password",
        body: { email: "person@example.test" },
      },
    ]);
    const markup = render(() => createElement(ForgotPasswordScreen));
    expect(markup).toContain(
      "If that email has an account, we sent a link. Check your inbox and spam folder.",
    );
    expect(FORGOT_SENT_MESSAGE).toContain("spam folder");
  });
});

describe("Reset password page", () => {
  it("sets the new password with the link token, then goes to sign-in with a note", async () => {
    const markup = render(() =>
      createElement(ResetPasswordScreen, { token: "tok_abc" }),
    );
    expect(markup.match(/type="password"/g)).toHaveLength(2);
    const calls = stubFetch(() => json(200, { ok: true }));
    await submitForm({
      newPassword: "brand-new-1",
      confirmPassword: "brand-new-1",
    });
    expect(calls[0]).toEqual({
      url: "/api/auth/reset-password",
      body: { token: "tok_abc", newPassword: "brand-new-1" },
    });
    expect(state.replace).toEqual(["/login?reset=done"]);
  });

  it("checks the two fields before sending", async () => {
    render(() => createElement(ResetPasswordScreen, { token: "tok_abc" }));
    const calls = stubFetch(() => json(200, { ok: true }));
    await submitForm({
      newPassword: "brand-new-1",
      confirmPassword: "different-1",
    });
    expect(calls).toHaveLength(0);
    expect(newPasswordProblem("short", "short")).toBe(
      "Choose a password between 8 and 128 characters.",
    );
    expect(newPasswordProblem("abcdefgh", "abcdefgh")).toBeNull();
  });

  it("shows a plain message and a way to ask for a new link when the link is no good", async () => {
    render(() => createElement(ResetPasswordScreen, { token: "tok_old" }));
    stubFetch(() =>
      json(400, {
        error: {
          code: "reset_link_invalid",
          message: "This link is no longer valid. Ask for a new one.",
        },
      }),
    );
    await submitForm({
      newPassword: "brand-new-1",
      confirmPassword: "brand-new-1",
    });
    const markup = render(() =>
      createElement(ResetPasswordScreen, { token: "tok_old" }),
    );
    expect(markup).toContain(
      "This link is no longer valid. Ask for a new one.",
    );
    expect(markup).toContain('href="/forgot-password"');
    expect(
      render(() => createElement(ResetPasswordScreen, { token: "" })),
    ).toContain("Ask for a new link");
  });
});

describe("Sign-in screen", () => {
  it("links to Forgot password and shows the after-reset note", () => {
    const markup = render(() =>
      createElement(AuthScreen, {
        mode: "login",
        notice: "Your password was changed. Sign in with your new password.",
      }),
    );
    expect(markup).toContain('href="/forgot-password"');
    expect(markup).toContain("Forgot password?");
    expect(markup).toContain("Sign in with your new password.");
  });
});

describe("Forced password change", () => {
  it("/api/me's flag reaches the session", () => {
    const raw = {
      user: { id: "u", email: "a@b.c" },
      profile: { id: "p", role: "sales", status: "active" },
      capabilities: [],
    };
    expect(
      toMe({ ...raw, mustChangePassword: true } as never)?.mustChangePassword,
    ).toBe(true);
    expect(toMe(raw as never)?.mustChangePassword).toBeUndefined();
  });

  it("asks for the temporary password and reports the change", async () => {
    const onChanged = vi.fn();
    const markup = render(() =>
      createElement(ChangePassword, { forced: true, onChanged }),
    );
    expect(markup).toContain("Set a new password");
    expect(markup).toContain("Temporary password");
    expect(markup).not.toContain("Current password");
    const calls = stubFetch(() => json(200, { ok: true }));
    await submitForm({
      currentPassword: "K7PQ-M4XR-2W",
      newPassword: "my-own-choice",
      confirmPassword: "my-own-choice",
    });
    expect(calls[0]?.url).toBe("/api/auth/change-password");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("People: Reset password", () => {
  const target = {
    profileId: "p1",
    name: "Ana Cruz",
    email: "ana@example.test",
    role: "sales",
    status: "active",
  };

  it("is offered only where the server would allow it", () => {
    expect(canResetPassword(target, true, "admin", "me")).toBe(true);
    expect(canResetPassword(target, false, "manager", "me")).toBe(false);
    expect(canResetPassword(target, true, "admin", "p1")).toBe(false);
    expect(
      canResetPassword({ ...target, role: "super_admin" }, true, "admin", "me"),
    ).toBe(false);
    expect(
      canResetPassword(
        { ...target, role: "super_admin" },
        true,
        "super_admin",
        "me",
      ),
    ).toBe(true);
    expect(
      canResetPassword({ ...target, status: "disabled" }, true, "admin", "me"),
    ).toBe(false);
    expect(
      canResetPassword(
        { ...target, email: "bot@chat-agents.sunpride.invalid" },
        true,
        "admin",
        "me",
      ),
    ).toBe(false);
  });

  it("confirms, then shows the temporary password once with Copy and the email line", async () => {
    const result: ResetResult = {
      temporaryPassword: "K7PQ-M4XR-2W",
      expiresAt: Date.now() + 72 * 3600_000,
      emailed: true,
      email: "ana@example.test",
    };
    const send = vi.fn(async () => result);
    const dialog = () =>
      createElement(ResetPasswordDialog, { target, onClose: () => {}, send });
    const confirm = render(dialog);
    expect(confirm).toContain("Reset password?");
    expect(confirm).not.toContain("K7PQ");
    await pressButton("Reset password");
    expect(send).toHaveBeenCalledWith("p1");
    const shown = render(dialog);
    expect(shown).toContain("K7PQ-M4XR-2W");
    expect(shown).toContain("Also sent to ana@example.test");
    expect(shown).toContain(
      "It expires in 3 days. They will choose their own password when they sign in.",
    );
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await pressButton("Copy");
    expect(writeText).toHaveBeenCalledWith("K7PQ-M4XR-2W");
    expect(render(dialog)).toContain("Copied");
    expect(EXPIRY_LINE).toContain("3 days");
  });

  it("tells the admin to send it themselves when the email failed", () => {
    expect(emailLine({ emailed: false, email: "ana@example.test" })).toBe(
      "Email could not be sent — send it yourself",
    );
  });

  it("shows the server's plain refusal", async () => {
    const send = vi.fn(async () => {
      const { ApiError } = await import("../../lib/api/errors");
      throw new ApiError({
        code: "reset_not_allowed",
        message: "Only a super admin can reset a super admin's password.",
      });
    });
    const dialog = () =>
      createElement(ResetPasswordDialog, { target, onClose: () => {}, send });
    render(dialog);
    await pressButton("Reset password");
    expect(render(dialog)).toContain(
      "Only a super admin can reset a super admin&#x27;s password.",
    );
  });
});
