"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { ApiError } from "../api/errors";
import { useApi, useLive } from "../api/hooks";
import { useApiStore, useLiveClient } from "../api/provider";
import type { QuerySnapshot } from "../api/store";
import {
  createAuthActions,
  fetchMe,
  SESSION_KEY,
  SESSION_TOPIC,
  type AuthActions,
} from "./client";
import type { Me, SessionProfile, SessionStatus } from "./types";

export type SessionValue = AuthActions & {
  status: SessionStatus;
  me: Me | null;
  profile: SessionProfile | null;
  error: ApiError | undefined;
  refresh: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

/** Server refusals of a signed-in person (not invited, turned off, no scope). */
const REFUSED_STATUSES = new Set([403, 404, 422]);

export function deriveSessionStatus(
  snapshot: Pick<QuerySnapshot<Me | null>, "data" | "error" | "status">,
): SessionStatus {
  if (snapshot.status === "error" && snapshot.error) {
    if (REFUSED_STATUSES.has(snapshot.error.status)) return "refused";
    // A transient failure while a session is known keeps the person in.
    if (snapshot.data) return "authenticated";
    return "error";
  }
  if (snapshot.data === undefined) return "loading";
  return snapshot.data === null ? "unauthenticated" : "authenticated";
}

/**
 * The signed-in person, from `GET /api/me` (profile provisioning is the
 * server's job there — no client `ensure`). Must sit inside ApiProvider.
 * Clears every cache on sign-in/out and whenever the subject changes, and
 * re-checks the session when any request comes back 401.
 */
export function SessionProvider({ children }: { children?: ReactNode }) {
  const store = useApiStore();
  const live = useLiveClient();
  const query = useApi<Me | null>(SESSION_KEY, ({ signal }) => fetchMe(signal));
  useLive(SESSION_TOPIC, [SESSION_KEY]);

  useEffect(
    () =>
      store.onError((error, key) => {
        if (error.status === 401 && key[0] !== SESSION_KEY[0])
          store.invalidate([SESSION_KEY], { immediate: true });
      }),
    [store],
  );

  const subject = query.data?.profile.subject ?? null;
  const previousSubject = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (query.data === undefined) return;
    const prior = previousSubject.current;
    previousSubject.current = subject;
    // Another identity under the same tab (expired then re-signed as someone
    // else, or a server-side revoke): nothing cached may survive.
    if (prior !== undefined && prior !== subject) {
      live.reset();
      void store.clear({ keep: [SESSION_KEY] });
    }
  }, [query.data, subject, store, live]);

  const actions = useMemo(() => createAuthActions(store, live), [store, live]);
  const status = deriveSessionStatus(query);
  const me = query.data ?? null;
  const value = useMemo<SessionValue>(
    () => ({
      ...actions,
      status,
      me,
      profile: me?.profile ?? null,
      error: query.error,
      refresh: query.refetch,
    }),
    [actions, status, me, query.error, query.refetch],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** The signed-in role, or null outside a SessionProvider (static previews, tests). */
export function useOptionalRole(): string | null {
  return useContext(SessionContext)?.me?.profile.role ?? null;
}

export type Permissions = {
  role: string | null;
  /** The signed-in profile id (SP-0175: "waiting for me" excludes my own submissions). */
  profileId?: string | null;
  permissions: ReadonlySet<string>;
  /** UI hint only — the API authorizes every request itself. */
  can: (capability: string) => boolean;
};

const NO_PERMISSIONS: ReadonlySet<string> = new Set();

export function usePermissions(): Permissions {
  const { me } = useSession();
  return useMemo(() => {
    const permissions = me ? new Set(me.permissions) : NO_PERMISSIONS;
    return {
      role: me?.profile.role ?? null,
      profileId: me?.profile.id ?? null,
      permissions,
      can: (capability: string) => permissions.has(capability),
    };
  }, [me]);
}
