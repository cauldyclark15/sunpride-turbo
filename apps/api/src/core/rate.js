import { ApiError } from "./errors.js";

/**
 * Fixed-window counters in `rate_limits` (atomic upsert, so concurrent requests cannot all
 * pass a shared pre-check). Engineering values, not client policy.
 * @typedef {{ limit: number, windowMs: number }} Policy
 */

/** Signed request rate per device: every signed request needs one challenge. */
export const CHALLENGE_POLICY = { limit: 60, windowMs: 120_000 };
/** Invalid proof / bind attempts per subject. */
export const FAILURE_POLICY = { limit: 10, windowMs: 300_000 };
/** Failed password sign-ins per email. */
export const SIGNIN_POLICY = { limit: 10, windowMs: 300_000 };

/**
 * Spend one unit. Returns 0 when allowed, else ms until the window resets.
 * @param {any} db @param {string} key @param {Policy} policy
 */
export async function take(db, key, policy) {
  const windowSecs = policy.windowMs / 1000;
  const rows = await db`
    insert into rate_limits (bucket_key, window_start, count) values (${key}, now(), 1)
    on conflict (bucket_key) do update set
      window_start = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSecs})
                          then now() else rate_limits.window_start end,
      count = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSecs})
                   then 1 else rate_limits.count + 1 end,
      updated_at = now()
    returning count, (extract(epoch from (window_start - now())) * 1000)::bigint + ${policy.windowMs}::bigint as reset_ms`;
  const row = rows[0];
  if (Number(row.count) <= policy.limit) return 0;
  return Math.max(1, Number(row.reset_ms));
}

/** Peek: ms of back-off if the budget is already spent, else 0. @param {any} db @param {string} key @param {Policy} policy */
export async function backoff(db, key, policy) {
  const rows = await db`
    select count, (extract(epoch from (window_start - now())) * 1000)::bigint + ${policy.windowMs}::bigint as reset_ms
    from rate_limits where bucket_key = ${key}`;
  const row = rows[0];
  if (!row || Number(row.reset_ms) <= 0 || Number(row.count) < policy.limit)
    return 0;
  return Number(row.reset_ms);
}

/** Give a reserved unit back. @param {any} db @param {string} key */
export async function refund(db, key) {
  await db`update rate_limits set count = greatest(count - 1, 0), updated_at = now() where bucket_key = ${key}`;
}

/** @param {any} db @param {string} key @param {Policy} policy */
export async function takeOrThrow(db, key, policy) {
  const wait = await take(db, key, policy);
  if (wait > 0)
    throw new ApiError("rate_limited", 429, "Too many requests", true, {
      action: "retry",
      retryAfterMs: wait,
    });
}

export const challengeKey = (/** @type {string} */ deviceId) =>
  `challenge:${deviceId}`;
export const failureKey = (/** @type {string} */ subject) =>
  `failure:${subject}`;
export const signinKey = (/** @type {string} */ email) => `signin:${email}`;
