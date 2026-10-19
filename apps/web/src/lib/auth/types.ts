/**
 * `GET /api/me` (BACKEND_V2 §3; shape from mobile inventory D3, web variant:
 * cookie auth, no device headers so `device` is null). Fields beyond the
 * documented ones are optional so a richer server answer never breaks the app.
 */
export type SessionProfile = {
  id: string;
  subject: string;
  name: string;
  email?: string;
  role: string;
  orgUnitId: string | null;
  active: boolean;
};

export type SessionScope = {
  id: string;
  fingerprint: string;
  epoch: string;
  orgUnitIds: string[];
};

export type Me = {
  version?: number;
  serverTime?: number;
  profile: SessionProfile;
  scope: SessionScope | null;
  permissions: string[];
  device?: unknown;
};

export type SessionStatus =
  /** Waiting for `/api/me`. */
  | "loading"
  /** Signed in with an active-or-inactive profile (check `profile.active`). */
  | "authenticated"
  /** No valid `sp_session` (401). */
  | "unauthenticated"
  /** Signed in, but the server refused a profile (403/404: not invited, turned off, no scope). */
  | "refused"
  /** The API could not answer (network, 5xx). */
  | "error";

type RawMe = {
  version?: number;
  serverTime?: number;
  user?: { id?: string; email?: string } | null;
  profile?:
    (Partial<SessionProfile> & { status?: string; userId?: string }) | null;
  scope?: SessionScope | null;
  permissions?: string[];
  capabilities?: string[];
  device?: unknown;
};

/**
 * Accepts both `/api/me` shapes: the documented one (`profile.active`,
 * `permissions`) and the Bun API's (`user`, `profile.status`, `capabilities`).
 * Returns `null` when the server knows the login but has no profile for it.
 */
export function toMe(raw: RawMe): Me | null {
  const p = raw.profile;
  if (!p || !p.id) return null;
  return {
    version: raw.version,
    serverTime: raw.serverTime,
    profile: {
      id: p.id,
      subject: p.subject ?? raw.user?.id ?? p.userId ?? p.id,
      name: p.name ?? raw.user?.email ?? "",
      email: p.email ?? raw.user?.email,
      role: p.role ?? "viewer",
      orgUnitId: p.orgUnitId ?? null,
      active: p.active ?? p.status === "active",
    },
    scope: raw.scope ?? null,
    permissions: raw.permissions ?? raw.capabilities ?? [],
    device: raw.device,
  };
}
