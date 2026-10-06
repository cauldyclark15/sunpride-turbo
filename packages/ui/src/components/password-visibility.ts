/**
 * Pure rules for the password show/hide toggle (SP-0127). Kept separate from
 * the React component so the behaviour is unit-testable without a DOM.
 *
 * The typed value is never read, stored or logged here: only the boolean
 * "is the text visible" state is.
 */

export type PasswordVisibility = boolean;

/** Every password field starts hidden. */
export const INITIAL_PASSWORD_VISIBILITY: PasswordVisibility = false;

export function togglePasswordVisibility(
  visible: PasswordVisibility,
): PasswordVisibility {
  return !visible;
}

export function passwordInputType(
  visible: PasswordVisibility,
): "text" | "password" {
  return visible ? "text" : "password";
}

/** Accessible name of the eye button: what pressing it will do. */
export function passwordToggleLabel(
  visible: PasswordVisibility,
): "Show password" | "Hide password" {
  return visible ? "Hide password" : "Show password";
}

/**
 * Moments when a visible password must be hidden again: the person leaves the
 * screen (tab hidden, page unloaded or restored from the back/forward cache)
 * or the form is sent. Unmounting the field resets it as well, because the
 * state lives in the component.
 */
export type PasswordRehideTrigger =
  | { kind: "visibilitychange"; hidden: boolean }
  | { kind: "pagehide" }
  | { kind: "pageshow" }
  | { kind: "submit" };

export function shouldRehidePassword(trigger: PasswordRehideTrigger): boolean {
  switch (trigger.kind) {
    case "visibilitychange":
      return trigger.hidden;
    case "pagehide":
    case "pageshow":
    case "submit":
      return true;
  }
}
