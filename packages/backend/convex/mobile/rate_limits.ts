import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

/**
 * Abuse/rate controls for the mobile field gateway (QSR-009). Engineering values, not
 * signed client policy: they leave headroom for a phone that reconnects after a day
 * offline (bootstrap pages + pull pages + push batches of 20 in one burst).
 *
 * - Batch sizes are bounded by the HTTP boundary (`MOBILE_LIMITS`).
 * - Request rate: every signed bootstrap/pull/push consumes exactly one one-time
 *   challenge, so a per-device token bucket on challenge issuance bounds the device's
 *   whole signed request rate (and bind attempts and outstanding challenge rows).
 * - Invalid retries: rejected requests (malformed, bad proof, replayed nonce, tampered
 *   cursor) spend a per-identity failure budget; when it is empty the identity is told
 *   to back off (HTTP 429) before any proof verification or database work.
 */
export const MOBILE_LIMITS = {
  maxBodyBytes: 128 * 1024,
  maxPushOperations: 20,
  maxPullLimit: 50,
  maxBootstrapLimit: 100,
} as const;

export type BucketPolicy = { capacity: number; refillMs: number };
/** Burst of 60 challenges, then one every 2 s (≤ ~1,800 signed requests per hour). */
export const CHALLENGE_BUCKET: BucketPolicy = { capacity: 60, refillMs: 2_000 };
/** 10 rejected requests in a burst, then one more every 30 s. */
export const FAILURE_BUCKET: BucketPolicy = { capacity: 10, refillMs: 30_000 };

export type BucketState = { tokens: number; updatedAt: number };
export type BucketDecision = {
  allowed: boolean;
  state: BucketState;
  retryAfterMs: number;
};

/** Pure token bucket: refills fractionally since `updatedAt`, never above capacity. */
export function available(
  state: BucketState | null,
  policy: BucketPolicy,
  now: number,
): number {
  if (!state) return policy.capacity;
  const elapsed = Math.max(0, now - state.updatedAt);
  return Math.min(policy.capacity, state.tokens + elapsed / policy.refillMs);
}

export function take(
  state: BucketState | null,
  policy: BucketPolicy,
  now: number,
): BucketDecision {
  const tokens = available(state, policy, now);
  if (tokens >= 1)
    return {
      allowed: true,
      state: { tokens: tokens - 1, updatedAt: now },
      retryAfterMs: 0,
    };
  return {
    allowed: false,
    state: { tokens, updatedAt: now },
    retryAfterMs: Math.ceil((1 - tokens) * policy.refillMs),
  };
}

const challengeKey = (deviceId: Id<"registeredDevices">) =>
  `challenge:${deviceId}`;
const failureKey = (subject: string) => `failure:${subject}`;

async function bucket(ctx: QueryCtx, key: string) {
  return await ctx.db
    .query("mobileRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function save(
  ctx: MutationCtx,
  key: string,
  existing: Awaited<ReturnType<typeof bucket>>,
  state: BucketState,
) {
  if (existing) await ctx.db.patch(existing._id, state);
  else await ctx.db.insert("mobileRateLimits", { key, ...state });
}

/** Milliseconds the identity must wait because its invalid-request budget is spent; 0 if none. */
export async function failureBackoff(
  ctx: QueryCtx,
  subject: string,
  now: number,
): Promise<number> {
  const row = await bucket(ctx, failureKey(subject));
  const tokens = available(row, FAILURE_BUCKET, now);
  return tokens >= 1 ? 0 : Math.ceil((1 - tokens) * FAILURE_BUCKET.refillMs);
}

/**
 * Called by `devices.challenge` before it issues a nonce. Throws `rate_limited` (no write)
 * when the device's challenge budget or the caller's invalid-request budget is spent.
 */
export async function takeChallenge(
  ctx: MutationCtx,
  deviceId: Id<"registeredDevices">,
  subject: string,
  now: number,
): Promise<void> {
  if ((await failureBackoff(ctx, subject, now)) > 0)
    throw new ConvexError("rate_limited");
  const key = challengeKey(deviceId);
  const row = await bucket(ctx, key);
  const decision = take(row, CHALLENGE_BUCKET, now);
  if (!decision.allowed) throw new ConvexError("rate_limited");
  await save(ctx, key, row, decision.state);
}

/** HTTP pre-check: `now` comes from the action (queries must not read the clock). */
export const backoff = internalQuery({
  args: { subject: v.string(), now: v.number() },
  returns: v.number(),
  handler: async (ctx, { subject, now }) =>
    await failureBackoff(ctx, subject, now),
});

/** Spend one unit of the identity's invalid-request budget; returns the resulting backoff. */
export const recordFailure = internalMutation({
  args: { subject: v.string() },
  returns: v.number(),
  handler: async (ctx, { subject }) => {
    const now = Date.now();
    const key = failureKey(subject);
    const row = await bucket(ctx, key);
    const decision = take(row, FAILURE_BUCKET, now);
    // An exhausted bucket stays at its refilled level; time alone restores it.
    await save(ctx, key, row, decision.state);
    if (!decision.allowed) return decision.retryAfterMs;
    const left = decision.state.tokens;
    return left >= 1 ? 0 : Math.ceil((1 - left) * FAILURE_BUCKET.refillMs);
  },
});
