import { ApiError } from "./errors.js";
import { isUuid } from "./util.js";
/** No credentials/cloud requirement for local use. Sending is explicit, never inferred from a key.
 * @param {any} env */
export function notificationMailMode(env) {
  const provider = env.NOTIFICATION_EMAIL_PROVIDER ?? "dev_sink";
  if (!["dev_sink", "resend"].includes(provider))
    throw new ApiError(
      "notification_setup",
      503,
      "Choose the local mail sink or configure Resend.",
    );
  return provider;
}
/** F-507/F-608 provider idempotency and exact GET receipt verification. Accepted is NOT inbox delivery.
 * Only generic notification text is sent; financial facts stay behind the signed-in current scope.
 * @param {any} db @param {{key:string,to:string,subject:string,body:string,createdAt?:number}} message @param {any} env */
export async function sendNotificationMail(db, message, env) {
  await db`select pg_advisory_xact_lock(hashtextextended(${"notification-mail:" + message.key},0))`;
  const [old] =
    await db`select * from notification_email_deliveries where message_key=${message.key}`;
  if (old) return { state: old.state, provider: old.provider };
  const provider = notificationMailMode(env);
  let state = provider === "dev_sink" ? "dev_sink" : "accepted",
    providerId = null;
  // Resend retains idempotency for 24h. Never automatically re-send an uncertain older job.
  if (
    provider === "resend" &&
    message.createdAt != null &&
    Date.now() - message.createdAt > 23 * 3600_000
  )
    state = "expired";
  else if (provider === "resend") {
    const from = env.NOTIFICATION_EMAIL_FROM,
      key = env.RESEND_API_KEY;
    if (!from || !key)
      throw new ApiError(
        "notification_setup",
        503,
        "Configure the email sender and provider key; local development can use the mail sink.",
      );
    const base = new URL(
      env.NOTIFICATION_EMAIL_API_URL ?? "https://api.resend.com",
    );
    if (
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      !(
        base.origin === "https://api.resend.com" ||
        (base.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
      )
    )
      throw new ApiError(
        "notification_setup",
        503,
        "Use the official email API or an explicit loopback development server.",
      );
    try {
      const headers = {
        authorization: "Bearer " + key,
        "content-type": "application/json",
        "idempotency-key": message.key,
      };
      const response = await fetch(new URL("/emails", base), {
        method: "POST",
        headers,
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.body,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("provider_rejected");
      const receipt = /** @type {any} */ (await response.json());
      if (!isUuid(receipt.id)) throw new Error("provider_receipt");
      const readback = await fetch(new URL("/emails/" + receipt.id, base), {
        headers: { authorization: "Bearer " + key },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!readback.ok) throw new Error("provider_readback");
      const sent = /** @type {any} */ (await readback.json());
      if (
        sent.id !== receipt.id ||
        sent.from !== from ||
        sent.subject !== message.subject ||
        sent.text !== message.body ||
        !Array.isArray(sent.to) ||
        sent.to.length !== 1 ||
        sent.to[0] !== message.to
      )
        throw new Error("provider_mismatch");
      providerId = receipt.id;
    } catch {
      throw new ApiError(
        "notification_retry",
        503,
        "Email provider acceptance could not be verified; delivery will retry.",
        true,
      );
    }
  }
  await db`insert into notification_email_deliveries(message_key,recipient,subject,body,provider,state,provider_id)values(${message.key},${message.to},${message.subject},${message.body},${provider},${state},${providerId})`;
  return { state, provider };
}
