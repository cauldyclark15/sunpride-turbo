import { noteWaitingPhone } from "../domains/integrity/waiting-phones.js";
import { tx } from "@sunpride/db/client";
import {
  nativeControl,
  recordDeviceAssessment,
  requireDeviceIntegrity,
} from "../domains/integrity/governance.js";
import { refuseRevokedPhone, registerSamplePhone } from "./sample-devices.js";
import { capabilitiesFor } from "./capabilities.js";
import {
  OFFICE_APPS,
  SESSION_COOKIE,
  readBearer,
  readCookie,
  sessionByToken,
} from "./context.js";
import {
  ApiError,
  NOT_SET_UP_MESSAGE,
  forbidden,
  invalid,
  unauthenticated,
} from "./errors.js";
import { isEmailInvited, loadProfile } from "./hooks.js";
import {
  SIGNIN_POLICY,
  backoff,
  signinKey,
  take,
  takeOrThrow,
} from "./rate.js";
import { reply } from "./router.js";
import { scopeOf } from "./scope.js";
import { HEX64_RE, isPlainObject, randomToken, sha256Hex } from "./util.js";

/** The one row that speaks for a handheld key: a live (active) row beats a newer revoked, suspended or pending one,
 * so an old removed row never overrules the person's current registration. SQL ordering fragment.
 * @param {any} db */
const deviceRank = (db) =>
  db`case status when 'active' then 0 when 'suspended' then 1 when 'pending' then 2 else 3 end`;

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const NATIVE_APPS = Object.freeze([
  "field-android",
  "van-android",
  "field-ios",
  "office-ios",
]);
export { OFFICE_APPS };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
// Dummy argon2id hash so unknown emails cost the same as wrong passwords.
const DUMMY_HASH = await Bun.password.hash("not-a-real-password-sunpride", {
  algorithm: "argon2id",
});

/** @param {unknown} v */
export const normalizeEmail = (v) =>
  typeof v === "string" ? v.trim().toLowerCase() : "";

/** @param {Record<string,string|undefined>} env */
export function bootstrapEmails(env) {
  return new Set(
    (env.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

/** @param {unknown} password */
function validPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 256
  );
}

/** @param {import('./context.js').Ctx} ctx @param {string} token @param {number} maxAgeMs */
export function setSessionCookie(ctx, token, maxAgeMs) {
  const secure =
    ctx.url.protocol === "https:" ||
    ctx.req.headers.get("x-forwarded-proto") === "https" ||
    ctx.env.COOKIE_SECURE === "1";
  ctx.cookies.push(
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`,
  );
}

/** @param {import('./context.js').Ctx} ctx */
function clearSessionCookie(ctx) {
  ctx.cookies.push(
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

/** @param {any} db @param {string} userId @param {string} app @param {string|null} deviceKeyId */
export async function createSession(db, userId, app, deviceKeyId) {
  const token = randomToken("sps_");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const [row] = await db`
    insert into sessions (token_hash, user_id, app, device_key_id, expires_at)
    values (${sha256Hex(token)}, ${userId}, ${app}, ${deviceKeyId}, ${new Date(expiresAt)})
    returning id`;
  return { token, id: /** @type {string} */ (row.id), expiresAt };
}

/** @param {any} db @param {string} sessionId */
export async function createAccess(db, sessionId) {
  const token = randomToken("spa_");
  const expiresAt = Date.now() + ACCESS_TTL_MS;
  await db`insert into access_tokens (token_hash, session_id, expires_at)
           values (${sha256Hex(token)}, ${sessionId}, ${new Date(expiresAt)})`;
  // Opportunistic cleanup of this session's expired access rows.
  await db`delete from access_tokens where session_id = ${sessionId} and expires_at < now() - interval '1 hour'`;
  return { token, expiresAt };
}

/** @param {unknown} body */
function readApp(body) {
  const app = isPlainObject(body) && body.app !== undefined ? body.app : "web";
  if (app !== "web" && !NATIVE_APPS.includes(/** @type {string} */ (app)))
    throw invalid("Unknown app");
  return /** @type {string} */ (app);
}

/** @param {unknown} body */
function requireV2(body) {
  if (!isPlainObject(body) || body.version !== 2)
    throw new ApiError(
      "version_unsupported",
      426,
      "Protocol version 2 required",
      false,
      { action: "update" },
    );
}

/** @param {unknown} deviceKey */
function readDeviceKey(deviceKey) {
  if (deviceKey === undefined || deviceKey === null) return null;
  if (!isPlainObject(deviceKey)) throw invalid("Invalid device key");
  const { keyId, publicKeySpki } = deviceKey;
  if (typeof keyId !== "string" || !HEX64_RE.test(keyId))
    throw invalid("Invalid device key id");
  if (publicKeySpki !== undefined && publicKeySpki !== null) {
    if (typeof publicKeySpki !== "string" || publicKeySpki.length > 512)
      throw invalid("Invalid device key");
    const bytes = Buffer.from(publicKeySpki, "base64");
    if (
      bytes.toString("base64") !== publicKeySpki ||
      sha256Hex(bytes) !== keyId
    )
      throw invalid("Device key id does not match the public key");
  }
  return keyId;
}

/** @param {import('./router.js').Router} router */
export function installAuth(router) {
  router.post("/api/auth/sign-up", async (ctx) => {
    const body = ctx.body;
    if (!isPlainObject(body)) throw invalid();
    const email = normalizeEmail(body.email);
    if (!EMAIL_RE.test(email) || email.length > 254)
      throw invalid("Enter a valid email");
    if (!validPassword(body.password))
      throw invalid("Password must be 8 to 256 characters", "weak_password");
    const allowed =
      bootstrapEmails(ctx.env).has(email) ||
      (await isEmailInvited(ctx.db, email));
    if (!allowed)
      throw forbidden("This email has no invitation", "not_invited");
    const passwordHash = await Bun.password.hash(
      /** @type {string} */ (body.password),
      { algorithm: "argon2id" },
    );
    const rows = await ctx.db`
      insert into users (email, password_hash) values (${email}, ${passwordHash})
      on conflict (email) do nothing returning id`;
    if (!rows.length)
      throw new ApiError(
        "email_taken",
        409,
        "An account already exists for this email",
      );
    const userId = /** @type {string} */ (rows[0].id);
    const session = await createSession(ctx.db, userId, "web", null);
    setSessionCookie(ctx, session.token, SESSION_TTL_MS);
    return reply(201, { user: { id: userId, email } });
  });

  router.post("/api/auth/sign-in", async (ctx) => {
    const body = ctx.body;
    if (!isPlainObject(body)) throw invalid();
    const app = readApp(body);
    const native = app !== "web";
    if (native) {
      ctx.v2 = true;
      requireV2(body);
    }
    const office = OFFICE_APPS.includes(app);
    if (office && body.deviceKey !== undefined && body.deviceKey !== null)
      throw invalid("The office app does not register a device key");
    const deviceKeyId = native ? readDeviceKey(body.deviceKey) : null;
    const email = normalizeEmail(body.email);
    if (
      !email ||
      typeof body.password !== "string" ||
      body.password.length > 256
    )
      throw invalid("Email and password are required");
    const wait = await backoff(ctx.db, signinKey(email), SIGNIN_POLICY);
    if (wait > 0)
      throw new ApiError("rate_limited", 429, "Too many attempts", true, {
        action: "retry",
        retryAfterMs: wait,
      });
    // Share the user row lock with change-password: a sign-in that verified the
    // old hash cannot create a fresh session after the revocation transaction.
    const signedIn = await tx(ctx.db, async (t) => {
      const [user] =
        await t`select id, password_hash, disabled_at from users where email = ${email} for update`;
      const ok = await Bun.password.verify(
        /** @type {string} */ (body.password),
        user?.password_hash ?? DUMMY_HASH,
      );
      if (!user || !ok || user.disabled_at) return null;
      if (native && deviceKeyId)
        await refuseRevokedPhone(t, user.id, app, deviceKeyId);
      if (native && deviceKeyId)
        await registerSamplePhone(t, user.id, app, body.deviceKey);
      if (native && deviceKeyId)
        await noteWaitingPhone(t, user.id, app, body.deviceKey);
      const session = await createSession(t, user.id, app, deviceKeyId);
      const access = native ? await createAccess(t, session.id) : null;
      return { user, session, access };
    });
    if (!signedIn) {
      await take(ctx.db, signinKey(email), SIGNIN_POLICY);
      throw unauthenticated(
        "Email or password is incorrect",
        "invalid_credentials",
      );
    }
    const { user, session, access } = signedIn;
    if (native && deviceKeyId) {
      const profile = await loadProfile(ctx.db, user.id);
      if (profile) {
        const [device] =
          await ctx.db`select * from registered_devices where profile_id=${profile.id} and key_id=${deviceKeyId} and app=${app} and status<>'revoked' order by ${deviceRank(ctx.db)}, created_at desc limit 1`;
        if (device) {
          await recordDeviceAssessment(ctx.db, device, body.integrity);
          if (!(await nativeControl(ctx.db, profile.id, deviceKeyId, app))) {
            try {
              await requireDeviceIntegrity(ctx.db, device);
            } catch (e) {
              await ctx.db`update sessions set revoked_at=now() where id=${session.id}`;
              throw e;
            }
          }
        }
      }
    }
    if (!native) {
      setSessionCookie(ctx, session.token, SESSION_TTL_MS);
      return { user: { id: user.id, email } };
    }
    if (!access) throw new Error("Native access credential was not issued");
    return {
      version: 2,
      serverTime: Date.now(),
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
    };
  });

  router.post(
    "/api/auth/refresh",
    async (ctx) => {
      requireV2(ctx.body);
      const token = readBearer(ctx.req);
      if (!token?.startsWith("sps_"))
        throw unauthenticated("Session credential required", "session_invalid");
      const row = await sessionByToken(ctx.db, token);
      if (!row) {
        // FLD-014: a session the office ended by revoking/pausing its phone says so, so the phone can tell the
        // person plainly and keep their unsent work for recovery. Codes only; nothing else about the device leaks.
        const removed = await removedPhoneSession(ctx.db, token);
        if (removed)
          throw unauthenticated(
            "This phone was removed by the office",
            removed,
          );
      }
      if (!row || row.app === "web")
        throw unauthenticated("Session expired or revoked", "session_invalid");
      const body = ctx.body;
      if (body.app !== row.app)
        throw unauthenticated(
          "Session belongs to another app",
          "session_invalid",
        );
      if (
        body.deviceKeyId !== undefined &&
        body.deviceKeyId !== null &&
        typeof body.deviceKeyId !== "string"
      )
        throw invalid("Invalid device key id");
      if (row.device_key_id && body.deviceKeyId !== row.device_key_id)
        throw unauthenticated(
          "Session belongs to another device key",
          "session_invalid",
        );
      const profile = await loadProfile(ctx.db, row.user_id);
      if (profile && row.device_key_id) {
        const [device] =
          await ctx.db`select * from registered_devices where profile_id=${profile.id} and key_id=${row.device_key_id} and app=${row.app} order by ${deviceRank(ctx.db)}, created_at desc limit 1`;
        if (device) {
          await recordDeviceAssessment(ctx.db, device, body.integrity);
          if (
            !(await nativeControl(
              ctx.db,
              profile.id,
              row.device_key_id,
              row.app,
            ))
          ) {
            if (device.status === "revoked")
              throw forbidden(NOT_SET_UP_MESSAGE, "device_revoked");
            if (device.status !== "active")
              throw forbidden("Phone is paused", "device_suspended");
            await requireDeviceIntegrity(ctx.db, device);
          }
        }
      }
      const access = await createAccess(ctx.db, row.session_id);
      return {
        version: 2,
        serverTime: Date.now(),
        sessionExpiresAt: new Date(row.expires_at).getTime(),
        accessToken: access.token,
        accessExpiresAt: access.expiresAt,
      };
    },
    { v2: true },
  );

  router.post("/api/auth/change-password", async (ctx) => {
    const { user, session } = ctx;
    if (!user || !session) throw unauthenticated();
    // Reserve the budget before password verification, outside the business transaction
    // so a refused attempt still counts. Password changes need no app capability.
    await takeOrThrow(ctx.db, `change-password:${user.id}`, SIGNIN_POLICY);
    const body = ctx.body;
    if (!isPlainObject(body)) throw invalid();
    const { currentPassword, newPassword } = body;
    return tx(ctx.db, async (t) => {
      const [stored] =
        await t`select password_hash, disabled_at from users where id=${user.id} for update`;
      const [active] =
        await t`select id from sessions where id=${session.id} and user_id=${user.id} and revoked_at is null and expires_at > now()`;
      if (!stored || stored.disabled_at || !active) throw unauthenticated();
      if (
        typeof currentPassword !== "string" ||
        currentPassword.length > 256 ||
        !(await Bun.password.verify(currentPassword, stored.password_hash))
      )
        throw new ApiError(
          "wrong_password",
          422,
          "Your current password is incorrect.",
        );
      if (
        typeof newPassword !== "string" ||
        newPassword.length < 8 ||
        newPassword.length > 128
      )
        throw new ApiError(
          "weak_password",
          422,
          "Choose a password between 8 and 128 characters.",
        );
      if (newPassword === currentPassword)
        throw new ApiError(
          "same_password",
          422,
          "Choose a different password from your current one.",
        );
      const hash = await Bun.password.hash(newPassword, {
        algorithm: "argon2id",
      });
      await t`update users set password_hash=${hash}, updated_at=now() where id=${user.id}`;
      await t`update sessions set revoked_at=now() where user_id=${user.id} and id<>${session.id} and revoked_at is null`;
      await t`delete from access_tokens where session_id in (select id from sessions where user_id=${user.id} and id<>${session.id})`;
      await t`insert into audit_logs(subject,action,entity_type,entity_id) values (${user.id},'auth.password_changed','user',${user.id})`;
      return { ok: true };
    });
  });

  router.post("/api/auth/sign-out", async (ctx) => {
    const bearer = readBearer(ctx.req);
    if (bearer) {
      ctx.v2 = true;
      if (bearer.startsWith("sps_"))
        await ctx.db`update sessions set revoked_at = now() where token_hash = ${sha256Hex(bearer)} and revoked_at is null`;
      else if (bearer.startsWith("spa_"))
        await ctx.db`update sessions set revoked_at = now()
                     where revoked_at is null and id = (select session_id from access_tokens where token_hash = ${sha256Hex(bearer)})`;
      return { version: 2, revoked: true };
    }
    const cookie = readCookie(ctx.req, SESSION_COOKIE);
    if (cookie)
      await ctx.db`update sessions set revoked_at = now() where token_hash = ${sha256Hex(cookie)} and revoked_at is null`;
    clearSessionCookie(ctx);
    return { revoked: true };
  });

  router.get("/api/me", async (ctx) => {
    if (!ctx.user || !ctx.session) throw unauthenticated();
    if (
      ctx.via === "access" &&
      ctx.session.app !== "web" &&
      !OFFICE_APPS.includes(ctx.session.app)
    )
      return nativeMe(ctx);
    const profile = await loadProfile(ctx.db, ctx.user.id);
    // WEB-016: an invited person whose profile was turned off is told so, not "not invited".
    const [off] = profile
      ? []
      : await ctx.db`select 1 from profiles where user_id=${ctx.user.id} and status='disabled' and deleted_at is null limit 1`;
    const { partnerContext } = await import("../domains/partners/boundary.js");
    const partner = await partnerContext(ctx.db, ctx.actor);
    return {
      user: ctx.user,
      profile: profile
        ? {
            id: profile.id,
            name: profile.name ?? null,
            role: profile.role,
            orgUnitId: profile.orgUnitId ?? null,
            status: profile.status,
          }
        : null,
      capabilities: ctx.actor ? [...ctx.actor.capabilities] : [],
      ...(off ? { access: "turned_off" } : {}),
      ...(partner
        ? {
            partner: {
              id: partner.distributor_id,
              kind: partner.partner_kind,
              name: partner.name,
            },
          }
        : {}),
    };
  });
}

/** D3 `/api/me` for native apps. @param {import('./context.js').Ctx} ctx */
async function nativeMe(ctx) {
  ctx.v2 = true;
  const actor = ctx.actor;
  if (!actor)
    throw forbidden(
      "No active profile for this account",
      "profile_unavailable",
    );
  const app = ctx.req.headers.get("x-app") ?? ctx.session?.app;
  const keyId = ctx.req.headers.get("x-device-key-id");
  if (app !== ctx.session?.app)
    throw invalid("X-App does not match the session");
  if (keyId !== null && !HEX64_RE.test(keyId))
    throw invalid("Invalid X-Device-Key-Id");
  /** @type {any} */
  let device = null;
  if (keyId) {
    const rows = await ctx.db`
      select id, status, bound_subject, credential_id, app from registered_devices
      where profile_id = ${actor.profileId} and key_id = ${keyId} and app = ${app}
      order by ${deviceRank(ctx.db)}, created_at desc limit 1`;
    const d = rows[0];
    if (d)
      device = {
        id: d.id,
        status: d.status,
        bound: Boolean(
          d.bound_subject &&
          d.credential_id &&
          d.bound_subject === actor.subject,
        ),
        allowedApp: d.app,
        credentialId: d.credential_id ?? null,
      };
  }
  const scope = await scopeOf(ctx.db, actor);
  return {
    version: 2,
    serverTime: Date.now(),
    profile: {
      id: actor.profileId,
      subject: actor.subject,
      name: actor.name,
      role: actor.role,
      orgUnitId: actor.orgUnitId,
      active: true,
    },
    scope,
    permissions: capabilitiesFor(actor.role),
    deviceControl: await nativeControl(
      ctx.db,
      actor.profileId,
      keyId,
      String(app),
    ),
    handoverRequired:
      !device &&
      Boolean(
        (
          await ctx.db`select 1 from registered_devices where profile_id=${actor.profileId} limit 1`
        ).length,
      ),
    device,
  };
}

/**
 * FLD-014: the closed code for a native session revoked because its bound phone is now revoked/suspended.
 * Null for any other ended session (password change, sign-out, expiry).
 * @param {any} db @param {string} token
 */
export async function removedPhoneSession(db, token) {
  const [s] =
    await db`select user_id, app, device_key_id from sessions where token_hash = ${sha256Hex(token)}
      and revoked_at is not null and app <> 'web' and device_key_id is not null`;
  if (!s) return null;
  const profile = await loadProfile(db, s.user_id);
  if (!profile) return null;
  const rows =
    await db`select status from registered_devices where profile_id=${profile.id} and key_id=${s.device_key_id} and app=${s.app}`;
  const statuses = rows.map((/** @type {any} */ r) => r.status);
  if (statuses.includes("active")) return null;
  if (statuses.includes("revoked")) return "device_revoked";
  if (statuses.includes("suspended")) return "device_suspended";
  return null;
}
