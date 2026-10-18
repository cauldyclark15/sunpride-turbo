import { createAuthActions } from "./auth/client";

/**
 * Compatibility facade over `/api/auth/*` for code outside React. Inside
 * components prefer `useSession()` (same calls, bound to the provider's cache).
 */
const actions = createAuthActions();

export const authClient = {
  signIn: { email: actions.signIn },
  signUp: { email: actions.signUp },
  signOut: actions.signOut,
};
