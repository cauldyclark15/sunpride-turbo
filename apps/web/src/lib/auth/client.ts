import { ApiError, normalizeError } from "../api/errors";
import { apiFetch, type ApiFetchOptions } from "../api/fetch";
import type { LiveClient } from "../api/live";
import { defaultApiStore, type ApiStore } from "../api/store";
import { forgetDrafts } from "../messaging/drafts";
import { clearUserCaches } from "../pwa/caches";
import { resetDataSource } from "../pwa/data-source";
import {
  forgetSession,
  recallSession,
  rememberSession,
} from "./offline-session";
import { toMe, type Me } from "./types";

/** Cache key of the current session (`GET /api/me`). */
export const SESSION_KEY = ["me"] as const;
/** Realtime topic for session/profile/permission/scope changes. */
export const SESSION_TOPIC = "me";

type FetchImpl = ApiFetchOptions["fetchImpl"];

/**
 * Better-Auth-like result: a server refusal comes back as `error`
 * (its message is shown to the person); a network failure throws.
 */
export type AuthResult<T = unknown> =
  { data: T; error: null } | { data: null; error: ApiError };

async function authCall<T>(
  path: string,
  body: unknown,
  fetchImpl?: FetchImpl,
): Promise<AuthResult<T>> {
  try {
    return { data: await apiFetch<T>(path, { body, fetchImpl }), error: null };
  } catch (raw) {
    const error = normalizeError(raw);
    if (error.status > 0) return { data: null, error };
    throw error;
  }
}

/**
 * `GET /api/me`; resolves `null` when there is no valid session (401). With
 * no network at all it falls back to the last signed-in person on this
 * device (see offline-session), so the installed app opens offline.
 */
export async function fetchMe(
  signal?: AbortSignal,
  fetchImpl?: FetchImpl,
): Promise<Me | null> {
  try {
    const raw = await apiFetch<
      Parameters<typeof toMe>[0] & { access?: string }
    >("/api/me", { signal, fetchImpl });
    const me = toMe(raw);
    if (!me && raw?.access === "turned_off")
      throw new ApiError({
        code: "access_turned_off",
        message: "Your access has been turned off.",
        status: 403,
      });
    if (!me)
      throw new ApiError({
        code: "not_invited",
        message: "This email address has not been invited yet.",
        status: 403,
      });
    rememberSession(me);
    return me;
  } catch (raw) {
    const error = normalizeError(raw);
    if (error.status === 401) {
      await forgetLocalData();
      return null;
    }
    if (error.code === "network_error" && !signal?.aborted) {
      const remembered = recallSession();
      if (remembered) return remembered;
    }
    throw error;
  }
}

/** Removes everything this device kept for the signed-in person. */
export async function forgetLocalData() {
  forgetSession();
  forgetDrafts();
  resetDataSource();
  await clearUserCaches();
}

export type AuthActions = {
  signIn: (input: { email: string; password: string }) => Promise<AuthResult>;
  signUp: (input: {
    email: string;
    password: string;
    name: string;
  }) => Promise<AuthResult>;
  /** Revokes the session (best effort) and always clears local state. */
  signOut: () => Promise<void>;
};

/**
 * Sign-in/up/out against `/api/auth/*` (cookie `sp_session` is set and
 * cleared by the API). Every identity change bumps the cache epoch — all
 * cached data and in-flight responses from the previous identity are
 * discarded — and reconnects the realtime socket under the new cookie.
 */
export function createAuthActions(
  store: ApiStore = defaultApiStore,
  live?: LiveClient,
  fetchImpl?: FetchImpl,
): AuthActions {
  const identityChanged = async () => {
    live?.reset();
    await forgetLocalData();
    await store.clear();
  };
  return {
    async signIn({ email, password }) {
      const result = await authCall(
        "/api/auth/sign-in",
        { email, password },
        fetchImpl,
      );
      if (!result.error) await identityChanged();
      return result;
    },
    async signUp({ email, password, name }) {
      const result = await authCall(
        "/api/auth/sign-up",
        { email, password, name },
        fetchImpl,
      );
      if (!result.error) await identityChanged();
      return result;
    },
    async signOut() {
      try {
        await apiFetch("/api/auth/sign-out", { body: {}, fetchImpl });
      } catch {
        // Local sign-out happens regardless; the cookie expires server-side.
      } finally {
        await identityChanged();
      }
    },
  };
}
