import { cookies } from "next/headers";
import { normalizeError } from "../api/errors";
import { serverApi } from "../api/server";
import { toMe, type Me } from "./types";

export const SESSION_COOKIE = "sp_session";

export type ServerSession =
  | { status: "authenticated"; me: Me }
  | { status: "unauthenticated" }
  /** Signed in but refused a profile (not invited, turned off). */
  | { status: "refused"; code: string }
  /** The API did not answer; the client gate retries and explains. */
  | { status: "unavailable"; code: string };

/**
 * Session for server components: forwards the incoming cookie to
 * `GET /api/me`. Skips the call when there is no `sp_session` cookie.
 */
export async function getServerSession(): Promise<ServerSession> {
  if (!(await cookies()).has(SESSION_COOKIE))
    return { status: "unauthenticated" };
  try {
    const me = toMe(await serverApi<Parameters<typeof toMe>[0]>("/api/me"));
    if (!me) return { status: "refused", code: "not_invited" };
    return { status: "authenticated", me };
  } catch (raw) {
    const error = normalizeError(raw);
    if (error.status === 401) return { status: "unauthenticated" };
    if (error.status === 403 || error.status === 404 || error.status === 422)
      return { status: "refused", code: error.code };
    return { status: "unavailable", code: error.code };
  }
}

/**
 * True unless the server says there is no session. A refused or unreachable
 * profile still counts: the client gate shows the access message with a way
 * out, instead of bouncing between /login and /dashboard.
 */
export async function isAuthenticated() {
  return (await getServerSession()).status !== "unauthenticated";
}
