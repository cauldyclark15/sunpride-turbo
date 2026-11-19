import { appendFile } from "node:fs/promises";

/**
 * SP-0185 sign-in emails (reset links, temporary passwords). Separate from notification mail so
 * turning this on never starts TPM/analytics alerts. The message text carries a secret: it is never
 * written to a table, log, audit row or error. Deliveries record recipient, kind, provider id, state.
 *
 * @typedef {{ to: string, kind: 'reset_link'|'temporary_password'|'invitation', subject: string, text: string }} AuthMail
 * @typedef {(mail: AuthMail, env: Record<string,string|undefined>) => Promise<{ providerId: string|null }>} AuthMailSender
 */

export const DEFAULT_PUBLIC_WEB_URL = "https://sunpride.cauldnclark.com";
export const DEFAULT_AUTH_EMAIL_FROM =
  "Sunpride Support <support@cauldnclark.com>";

/** @type {AuthMailSender|null} */
let override = null;

/** Tests capture (or fail) messages here instead of any provider. @param {AuthMailSender|null} sender */
export function setAuthMailSender(sender) {
  override = sender;
}

/** @param {Record<string,string|undefined>} env */
export function authEmailProvider(env) {
  const p = env.AUTH_EMAIL_PROVIDER ?? "dev_sink";
  return p === "resend" ? "resend" : "dev_sink";
}

/** Reset links are built from configuration only, never from the request Host. @param {Record<string,string|undefined>} env */
export function publicWebUrl(env) {
  const raw = env.PUBLIC_WEB_URL || DEFAULT_PUBLIC_WEB_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return u.origin;
  } catch {
    return DEFAULT_PUBLIC_WEB_URL;
  }
}

/** @type {AuthMailSender} */
async function resendSender(mail, env) {
  const key = env.RESEND_API_KEY;
  if (!key) throw new Error("auth_email_not_configured");
  // Sending-only key: a 2xx with an id from POST /emails means accepted. No read-back.
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM || DEFAULT_AUTH_EMAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error("auth_email_rejected");
  const body = /** @type {any} */ (await res.json().catch(() => null));
  if (!body || typeof body.id !== "string" || !body.id)
    throw new Error("auth_email_no_receipt");
  return { providerId: body.id.slice(0, 200) };
}

/** Local/lane only: optionally append the message to an explicitly configured file so a person can open the link.
 * @type {AuthMailSender} */
async function devSinkSender(mail, env) {
  const file = env.AUTH_EMAIL_DEV_SINK_FILE;
  if (file)
    await appendFile(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...mail }) + "\n",
    );
  return { providerId: null };
}

/**
 * Send one sign-in email and record the delivery (no content). Never throws.
 * @param {any} db @param {Record<string,string|undefined>} env @param {AuthMail} mail
 * @returns {Promise<boolean>} true when the provider accepted it (or the dev sink took it)
 */
export async function sendAuthMail(db, env, mail) {
  return (await sendAuthMailResult(db, env, mail)) !== "failed";
}

/** Delivery state, not inbox delivery. Keep the dev sink distinct from a real send.
 * @param {any} db @param {Record<string,string|undefined>} env @param {AuthMail} mail
 * @returns {Promise<'dev_sink'|'accepted'|'failed'>}
 */
export async function sendAuthMailResult(db, env, mail) {
  const provider = override ? "test" : authEmailProvider(env);
  const sender =
    override ?? (provider === "resend" ? resendSender : devSinkSender);
  /** @type {'dev_sink'|'accepted'|'failed'} */
  let state = provider === "dev_sink" ? "dev_sink" : "accepted";
  /** @type {string|null} */
  let providerId = null;
  try {
    providerId = (await sender(mail, env)).providerId;
  } catch {
    state = "failed";
  }
  try {
    await db`insert into auth_email_deliveries (recipient, kind, provider, provider_id, state)
             values (${mail.to}, ${mail.kind}, ${provider}, ${providerId}, ${state})`;
  } catch {
    // Recording is best effort; the reset itself already happened.
  }
  return state;
}

/** @param {string} link */
export function resetLinkMail(link) {
  return {
    subject: "Reset your Sunpride password",
    text: [
      "Hello,",
      "",
      "Someone asked to reset the password for your Sunpride account.",
      "To choose a new password, open this link within 60 minutes:",
      "",
      link,
      "",
      "If you did not ask for this, you can ignore this email. Your password stays the same.",
      "",
      "Sunpride Support",
    ].join("\n"),
  };
}

/** @param {string} password @param {string} webUrl */
export function temporaryPasswordMail(password, webUrl) {
  return {
    subject: "Your new temporary Sunpride password",
    text: [
      "Hello,",
      "",
      "Your Sunpride administrator reset your password. Your temporary password is:",
      "",
      password,
      "",
      `Sign in at ${webUrl} or in the Sunpride app within 3 days.`,
      "You will then choose your own password.",
      "",
      "Sunpride Support",
    ].join("\n"),
  };
}
