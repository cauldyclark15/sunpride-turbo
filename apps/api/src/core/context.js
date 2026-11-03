import { capabilitiesFor } from "./capabilities.js";
import { loadProfile } from "./hooks.js";
import { sha256Hex } from "./util.js";

/**
 * @typedef {import('@sunpride/db/client').Db} Db
 * @typedef {{ userId: string, profileId: string, role: string, orgUnitId: string|null,
 *   capabilities: Set<string>, subject: string, name: string|null, scopeEpoch: string|null }} Actor
 * @typedef {{ id: string, userId: string, app: string, deviceKeyId: string|null, expiresAt: number }} SessionInfo
 * @typedef {{ id: string, email: string }} UserInfo
 * @typedef {{ kind: string, key?: string|null, runAt?: Date|number|null, payload?: unknown }} JobSpec
 * @typedef {{
 *   db: Db, actor: Actor|null, req: Request, url: URL, body: any, rawBody: Uint8Array, now: number,
 *   params: Record<string,string>, user: UserInfo|null, session: SessionInfo|null, via: 'cookie'|'access'|null,
 *   accessExpiresAt: number|null, device: any, v2: boolean, cookies: string[], env: Record<string,string|undefined>,
 *   server: any,
 *   publish: (topic: string) => Promise<void>, enqueue: (job: JobSpec) => Promise<string|null>,
 * }} Ctx
 */

export const SESSION_COOKIE = "sp_session";

/** @param {Request} req @param {string} name */
export function readCookie(req, name) {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** @param {Request} req */
export function readBearer(req) {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{8,256})$/.exec(h.trim());
  return m ? /** @type {string} */ (m[1]) : null;
}

/** @param {any} row @returns {SessionInfo} */
const sessionInfo = (row) => ({
  id: row.session_id,
  userId: row.user_id,
  app: row.app,
  deviceKeyId: row.device_key_id ?? null,
  expiresAt: new Date(row.expires_at).getTime(),
});

/**
 * Session by its own opaque token (web cookie, or native session bearer for refresh/sign-out).
 * @param {Db} db @param {string} token
 */
export async function sessionByToken(db, token) {
  const rows = await db`
    select s.id as session_id, s.user_id, s.app, s.device_key_id, s.expires_at, s.last_seen_at, u.email
    from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${sha256Hex(token)} and s.revoked_at is null and s.expires_at > now() and u.disabled_at is null`;
  return rows[0] ?? null;
}

/**
 * Resolve the caller from cookie `sp_session` or an access bearer. Session bearers do NOT
 * authenticate ordinary requests (D2): only refresh and sign-out read them.
 * @param {Db} db @param {Request} req
 */
export async function resolveAuth(db, req) {
  const bearer = readBearer(req);
  /** @type {any} */
  let row = null;
  /** @type {'cookie'|'access'|null} */
  let via = null;
  let accessExpiresAt = null;
  if (bearer?.startsWith("spa_")) {
    const rows = await db`
      select s.id as session_id, s.user_id, s.app, s.device_key_id, s.expires_at, s.last_seen_at, u.email,
             a.expires_at as access_expires_at
      from access_tokens a join sessions s on s.id = a.session_id join users u on u.id = s.user_id
      where a.token_hash = ${sha256Hex(bearer)} and a.expires_at > now()
        and s.revoked_at is null and s.expires_at > now() and u.disabled_at is null`;
    row = rows[0] ?? null;
    if (row) {
      via = "access";
      accessExpiresAt = new Date(row.access_expires_at).getTime();
    }
  } else if (!bearer) {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie?.startsWith("sps_")) {
      row = await sessionByToken(db, cookie);
      if (row && row.app !== "web") row = null;
      if (row) via = "cookie";
    }
  }
  // Agent credentials intentionally share the spa_ prefix with access tokens.
  // Only fall back after the existing session/access path failed, and never
  // authenticate an agent on a non-chat HTTP route.
  if (
    !row &&
    bearer?.startsWith("spa_") &&
    (new URL(req.url).pathname.startsWith("/api/v1/messaging/") ||
      new URL(req.url).pathname === "/ws")
  ) {
    const [agent] =
      await db`select a.user_id,a.display_name,p.id as profile_id,u.email
      from chat_agents a join users u on u.id=a.user_id join profiles p on p.user_id=u.id
      where a.token_hash=${sha256Hex(bearer)} and a.disabled_at is null and u.disabled_at is null
        and p.status='active' and p.deleted_at is null`;
    if (agent)
      return {
        user: { id: agent.user_id, email: String(agent.email) },
        session: null,
        via: null,
        accessExpiresAt: null,
        actor: {
          userId: agent.user_id,
          profileId: agent.profile_id,
          role: "chat_agent",
          orgUnitId: null,
          capabilities: new Set(["messaging.use"]),
          subject: agent.user_id,
          name: agent.display_name,
          scopeEpoch: null,
        },
      };
  }
  if (!row)
    return {
      user: null,
      session: null,
      actor: null,
      via: null,
      accessExpiresAt: null,
    };
  if (
    !row.last_seen_at ||
    Date.now() - new Date(row.last_seen_at).getTime() > 60_000
  )
    await db`update sessions set last_seen_at = now() where id = ${row.session_id}`;
  const session = sessionInfo(row);
  const user = { id: row.user_id, email: String(row.email) };
  const actor = await actorFor(db, user.id);
  return { user, session, actor, via, accessExpiresAt };
}

/**
 * Build the handler context (contract §3).
 * @param {{ db: Db, req: Request, url: URL, params: Record<string,string>, rawBody: Uint8Array, body: any,
 *   env: Record<string,string|undefined>, server: any, v2: boolean,
 *   publish: (db: Db, topic: string) => Promise<void>,
 *   enqueue: (db: Db, job: JobSpec) => Promise<string|null> }} input
 * @returns {Promise<Ctx>}
 */
export async function buildCtx(input) {
  const auth = await resolveAuth(input.db, input.req);
  const db = input.db;
  return {
    db,
    actor: auth.actor,
    req: input.req,
    url: input.url,
    body: input.body,
    rawBody: input.rawBody,
    now: Date.now(),
    params: input.params,
    user: auth.user,
    session: auth.session,
    via: auth.via,
    accessExpiresAt: auth.accessExpiresAt,
    device: null,
    v2: input.v2,
    cookies: [],
    env: input.env,
    server: input.server,
    publish: (topic) => input.publish(db, topic),
    enqueue: (job) => input.enqueue(db, job),
  };
}

/** @param {Db} db @param {string} userId @returns {Promise<Actor|null>} */
export async function actorFor(db, userId) {
  const profile = await loadProfile(db, userId);
  if (!profile || profile.status !== "active") return null;
  return {
    userId,
    profileId: profile.id,
    role: profile.role,
    orgUnitId: profile.orgUnitId ?? null,
    capabilities: new Set(capabilitiesFor(profile.role)),
    subject: userId,
    name: profile.name ?? null,
    scopeEpoch: profile.scopeEpoch ?? null,
  };
}
