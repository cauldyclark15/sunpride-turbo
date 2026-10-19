import { ApiError, normalizeError } from "../api/errors";
import { apiFetch, type ApiFetchOptions } from "../api/fetch";
import type { LiveClient } from "../api/live";
import { defaultApiStore, type ApiStore } from "../api/store";
import type { Me } from "./types";

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

/** `GET /api/me`; resolves `null` when there is no valid session (401). */
export async function fetchMe(
  signal?: AbortSignal,
  fetchImpl?: FetchImpl,
): Promise<Me | null> {
  try {
    const response = await apiFetch<
      | Me
      | {
          user: { id: string; email: string };
          profile: {
            id: string;
            name: string;
            role: string;
            orgUnitId: string | null;
            status: string;
          } | null;
          capabilities: string[];
        }
    >("/api/me", { signal, fetchImpl });
    if ("capabilities" in response) {
      if (!response.profile)
        throw new ApiError({
          code: "profile_unavailable",
          status: 403,
          message: "No active profile is available for this account.",
        });
      return {
        profile: {
          ...response.profile,
          subject: response.user.id,
          email: response.user.email,
          active: response.profile.status === "active",
        },
        scope: null,
        permissions: response.capabilities,
      };
    }
    return response;
  } catch (raw) {
    const error = normalizeError(raw);
    if (error.status === 401) return null;
    throw error;
  }
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
