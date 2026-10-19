import type { Me } from "./types";

/**
 * The last signed-in person, so the installed app can still open with the
 * figures it already loaded when the phone has no signal. It is not the
 * `/api/me` response (the service worker never caches that): only the
 * mapped session, used ONLY when `/api/me` cannot be reached at all. A 401,
 * sign-out or a different person deletes it.
 */
export const OFFLINE_SESSION_KEY = "sp.offline.session";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function rememberSession(me: Me, store = storage()) {
  try {
    store?.setItem(
      OFFLINE_SESSION_KEY,
      JSON.stringify({
        profile: me.profile,
        scope: me.scope,
        permissions: me.permissions,
      }),
    );
  } catch {
    // Storage full or blocked: offline opening simply is not available.
  }
}

export function forgetSession(store = storage()) {
  try {
    store?.removeItem(OFFLINE_SESSION_KEY);
  } catch {
    // Nothing stored.
  }
}

export function recallSession(store = storage()): Me | null {
  try {
    const raw = store?.getItem(OFFLINE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Me>;
    if (!parsed.profile?.subject || !Array.isArray(parsed.permissions))
      return null;
    return {
      profile: parsed.profile,
      scope: parsed.scope ?? null,
      permissions: parsed.permissions,
    };
  } catch {
    return null;
  }
}
