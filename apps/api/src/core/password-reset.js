import { tx } from "@sunpride/db/client";
import { requireCapability } from "./capabilities.js";
import { ApiError, invalid, unauthenticated } from "./errors.js";
import { passwordResetTarget } from "../domains/org/password-reset-target.js";
import { take, takeOrThrow } from "./rate.js";
import { b64url, isPlainObject, isUuid, sha256Hex } from "./util.js";
import {
  publicWebUrl,
  resetLinkMail,
  sendAuthMail,
  temporaryPasswordMail,
} from "./auth-email.js";

/** SP-0185: forgot password (reset link), reset by link, and admin reset with a temporary password. */

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const TEMP_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
/** Reset emails per address (silently skipped beyond this, so the reply never changes). */
export const FORGOT_EMAIL_POLICY = { limit: 3, windowMs: 15 * 60_000 };
/** Forgot / reset requests per client address. */
export const FORGOT_CLIENT_POLICY = { limit: 20, windowMs: 15 * 60_000 };
export const RESET_CLIENT_POLICY = { limit: 20, windowMs: 15 * 60_000 };

export const RESET_LINK_INVALID =
  "This link is no longer valid. Ask for a new one.";
export const WEAK_PASSWORD = "Choose a password between 8 and 128 characters.";

/** No 0/O, 1/l/I: easy to read aloud and to type from a Viber message. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Crypto-random temporary password, grouped like K7PQ-M4XR-2W (10 letters/digits). */
export function temporaryPassword() {
  /** @type {string[]} */
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 10) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b >= limit) continue;
      out.push(/** @type {string} */ (ALPHABET[b % ALPHABET.length]));
      if (out.length === 10) break;
    }
  }
  const s = out.join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Internal-only addresses cannot receive mail; admins can still copy their reset links. @param {string} email */
export const isAgentEmail = (email) =>
  /\.sunpride\.invalid$|\.local$/i.test(email.trim());

/** @param {import('./context.js').Ctx} ctx */
function clientKey(ctx) {
  const h = ctx.req.headers;
  const ip =
    h.get("cf-connecting-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ctx.server?.requestIP?.(ctx.req)?.address ??
    "unknown";
  return ip.slice(0, 64);
}

/** Revoke every session (and native access) of a user. @param {any} t @param {string} userId */
async function revokeAllSessions(t, userId) {
  await t`update sessions set revoked_at=now() where user_id=${userId} and revoked_at is null`;
  await t`delete from access_tokens where session_id in (select id from sessions where user_id=${userId})`;
}

/** @param {import('./router.js').Router} router */
export function installPasswordReset(router) {
  router.post("/api/auth/forgot-password", async (ctx) => {
    await takeOrThrow(
      ctx.db,
      `forgot-client:${clientKey(ctx)}`,
      FORGOT_CLIENT_POLICY,
    );
    const body = ctx.body;
    const email =
      isPlainObject(body) && typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";
    if (!email || email.length > 254 || !email.includes("@"))
      throw invalid("Enter a valid email");
    // Over the per-address budget: same answer, nothing sent.
    if ((await take(ctx.db, `forgot-email:${email}`, FORGOT_EMAIL_POLICY)) > 0)
      return { ok: true };
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const created = await tx(ctx.db, async (t) => {
      const [user] =
        await t`select id, email from users where email=${email} and disabled_at is null for update`;
      if (!user || isAgentEmail(String(user.email))) return null;
      await t`update password_reset_tokens set used_at=now() where user_id=${user.id} and used_at is null`;
      await t`insert into password_reset_tokens (user_id, token_hash, expires_at)
              values (${user.id}, ${sha256Hex(token)}, ${new Date(Date.now() + RESET_TOKEN_TTL_MS)})`;
      return { email: String(user.email) };
    });
    if (created) {
      const link = `${publicWebUrl(ctx.env)}/reset-password?token=${token}`;
      // Not awaited: the reply time must not tell whether the account exists.
      void sendAuthMail(ctx.db, ctx.env, {
        to: created.email,
        kind: "reset_link",
        ...resetLinkMail(link),
      });
    }
    return { ok: true };
  });

  router.post("/api/auth/reset-password", async (ctx) => {
    await takeOrThrow(
      ctx.db,
      `reset-client:${clientKey(ctx)}`,
      RESET_CLIENT_POLICY,
    );
    const body = ctx.body;
    if (!isPlainObject(body)) throw invalid();
    const { token, newPassword } = body;
    const bad = new ApiError("reset_link_invalid", 400, RESET_LINK_INVALID);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(token))
      throw bad;
    if (
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      newPassword.length > 128
    )
      throw new ApiError("weak_password", 422, WEAK_PASSWORD);
    const hash = await Bun.password.hash(newPassword, {
      algorithm: "argon2id",
    });
    return tx(ctx.db, async (t) => {
      const [row] = await t`select id, user_id from password_reset_tokens
                where token_hash=${sha256Hex(token)} and used_at is null and expires_at > now()`;
      if (!row) throw bad;
      const [user] =
        await t`select id, disabled_at from users where id=${row.user_id} for update`;
      // Re-read under the user lock: a concurrent use of the same link loses here.
      const [still] =
        await t`select 1 from password_reset_tokens where id=${row.id} and used_at is null`;
      if (!user || !still) throw bad;
      await t`update users set password_hash=${hash}, must_change_password=false,
              temp_password_expires_at=null, updated_at=now() where id=${user.id}`;
      await t`update password_reset_tokens set used_at=now() where user_id=${user.id} and used_at is null`;
      await revokeAllSessions(t, user.id);
      await t`insert into audit_logs(subject,action,entity_type,entity_id) values (${user.id},'auth.password_reset_by_link','user',${user.id})`;
      return { ok: true };
    });
  });

  router.post("/api/v1/people/reset-password", async (ctx) => {
    if (!ctx.user || !ctx.actor) throw unauthenticated();
    const actor = await requireCapability(ctx, "admin.manage");
    const body = ctx.body;
    if (!isPlainObject(body)) throw invalid();
    const selectors = ["userId", "profileId", "invitationId"].filter(
      (key) => body[key] !== undefined && body[key] !== null,
    );
    if (selectors.length !== 1 || !isUuid(body[selectors[0]]))
      throw invalid("Choose a person");
    const target = { [selectors[0]]: body[selectors[0]] };
    const password = temporaryPassword();
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const expiresAt = new Date(Date.now() + TEMP_PASSWORD_TTL_MS);
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const resetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    const resetUrl = `${publicWebUrl(ctx.env)}/reset-password?token=${token}`;
    const user = await tx(ctx.db, async (t) => {
      const user = await passwordResetTarget(t, target, actor.subject);
      if (user.orgUnitId)
        await requireCapability(
          { ...ctx, db: t },
          "admin.manage",
          user.orgUnitId,
        );
      await t`update users set password_hash=${hash}, must_change_password=true,
              temp_password_expires_at=${expiresAt}, updated_at=now() where id=${user.id}`;
      await t`update password_reset_tokens set used_at=now() where user_id=${user.id} and used_at is null`;
      await t`insert into password_reset_tokens(user_id,token_hash,expires_at)
        values (${user.id},${sha256Hex(token)},${resetExpiresAt})`;
      await revokeAllSessions(t, user.id);
      await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
              values (${actor.userId},'auth.password_reset_by_admin','user',${user.id},'Password reset link and temporary password issued')`;
      return user;
    });
    const email = String(user.email);
    const emailed =
      !isAgentEmail(email) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
      (await sendAuthMail(ctx.db, ctx.env, {
        to: email,
        kind: "temporary_password",
        ...temporaryPasswordMail(password, publicWebUrl(ctx.env), resetUrl),
      }));
    const selfReset = user.id === actor.userId;
    if (!selfReset) {
      try {
        await ctx.publish("me");
      } catch {
        // Realtime is a hint; revoked sessions already answer 401.
      }
    }
    // Do not invalidate the requesting screen during a self-reset: let them copy the
    // link first. Their sessions are already revoked, including on the next request.
    return {
      temporaryPassword: password,
      expiresAt: expiresAt.getTime(),
      resetUrl,
      resetExpiresAt: resetExpiresAt.getTime(),
      accessDisabled: user.accessDisabled,
      selfReset,
      emailed,
      email,
    };
  });
}
