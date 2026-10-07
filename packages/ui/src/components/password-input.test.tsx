import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PasswordInput } from "./password-input";
import {
  INITIAL_PASSWORD_VISIBILITY,
  passwordInputType,
  passwordToggleLabel,
  shouldRehidePassword,
  togglePasswordVisibility,
} from "./password-visibility";

describe("password show/hide rules", () => {
  it("starts hidden and toggles between hidden and shown", () => {
    expect(INITIAL_PASSWORD_VISIBILITY).toBe(false);
    expect(passwordInputType(INITIAL_PASSWORD_VISIBILITY)).toBe("password");
    const shown = togglePasswordVisibility(INITIAL_PASSWORD_VISIBILITY);
    expect(shown).toBe(true);
    expect(passwordInputType(shown)).toBe("text");
    const hiddenAgain = togglePasswordVisibility(shown);
    expect(hiddenAgain).toBe(false);
    expect(passwordInputType(hiddenAgain)).toBe("password");
  });

  it("labels the eye button with what pressing it will do", () => {
    expect(passwordToggleLabel(false)).toBe("Show password");
    expect(passwordToggleLabel(true)).toBe("Hide password");
  });

  it("hides the password again when the screen is left or the form is sent", () => {
    expect(
      shouldRehidePassword({ kind: "visibilitychange", hidden: true }),
    ).toBe(true);
    expect(shouldRehidePassword({ kind: "pagehide" })).toBe(true);
    expect(shouldRehidePassword({ kind: "pageshow" })).toBe(true);
    expect(shouldRehidePassword({ kind: "submit" })).toBe(true);
  });

  it("keeps the chosen state while the tab stays in view", () => {
    expect(
      shouldRehidePassword({ kind: "visibilitychange", hidden: false }),
    ).toBe(false);
  });
});

describe("PasswordInput", () => {
  const html = renderToStaticMarkup(
    createElement(PasswordInput, {
      id: "password",
      name: "password",
      autoComplete: "current-password",
      required: true,
      defaultValue: "s3cret-value",
    }),
  );

  it("renders hidden by default with a Show password eye button", () => {
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).not.toMatch(/<input[^>]*type="text"/);
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it("keeps the caller's field attributes for sign-in and password managers", () => {
    expect(html).toContain('id="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("required");
  });

  it("turns off spell check and autocorrect so a shown password is not sent anywhere", () => {
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('autoCorrect="off"');
    expect(html).toContain('autoCapitalize="none"');
  });

  it("never copies the typed value anywhere except the input itself", () => {
    expect(html.split("s3cret-value")).toHaveLength(2);
  });
});
