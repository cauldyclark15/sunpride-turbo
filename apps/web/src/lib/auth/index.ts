/**
 * Client-side session API. Server components use `@/lib/auth/server`
 * (`getServerSession`, `isAuthenticated`).
 */
export {
  createAuthActions,
  fetchMe,
  SESSION_KEY,
  SESSION_TOPIC,
} from "./client";
export type { AuthActions, AuthResult } from "./client";
export {
  deriveSessionStatus,
  SessionProvider,
  usePermissions,
  useSession,
} from "./session";
export type { Permissions, SessionValue } from "./session";
export { safeAuthDestination } from "./routing";
export type { Me, SessionProfile, SessionScope, SessionStatus } from "./types";
