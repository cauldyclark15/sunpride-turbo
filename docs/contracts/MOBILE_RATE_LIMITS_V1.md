# Mobile gateway abuse and rate controls (v1, QSR-009)

**Status:** implemented in `packages/backend/convex/mobile/rate_limits.ts`, wired into `mobile/devices:challenge` and the `/mobile/v1/*` HTTP actions. Verified with convex-test and HTTP-boundary unit tests (`rate_limits.test.ts`, `http_handlers.test.ts`); no live DEV or real-phone run yet. Values are engineering defaults, not signed client policy, and can be tuned in one place.

## What is bounded

| Control                      | Limit                                             | Where                                                                                  | On breach                                                               |
| ---------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Request body                 | 128 KiB                                           | HTTP boundary, before parsing                                                          | 413 `invalid_request`                                                   |
| Push batch                   | 1–20 operations                                   | HTTP boundary, before proof                                                            | 400 `invalid_request`                                                   |
| Pull page                    | `limit` 1–50                                      | HTTP boundary                                                                          | 400 `invalid_request`                                                   |
| Bootstrap page               | `limit` 1–100                                     | HTTP boundary                                                                          | 400 `invalid_request`                                                   |
| Call sheet lines / dependsOn | 100 lines / 20 UUIDs per operation                | HTTP boundary                                                                          | 400 `invalid_request`                                                   |
| Signed request rate          | burst 60, then 1 per 2 s, per device              | `devices.challenge` (every signed bootstrap/pull/push and bind consumes one challenge) | Convex error `rate_limited`, no challenge issued                        |
| Invalid retries              | burst 10, then 1 per 30 s, per signed-in identity | HTTP actions                                                                           | 429 `temporarily_unavailable`, `retryable: true`, `Retry-After` seconds |

"Invalid" means a request from a signed-in identity that the gateway rejects: malformed or oversized body (400/413), failed device proof, replayed nonce, wrong app or revoked/suspended phone (401), or a tampered/expired cursor (409 `invalid_cursor`). A legitimate `409 rebootstrap_required`, per-operation business rejections inside a 200 push response, and server errors (500) do **not** count. Requests without a valid bearer are rejected before any accounting (Convex validates the JWT).

While an identity's invalid budget is spent, the gateway answers 429 before reading the body or verifying any signature, and `devices.challenge` refuses that identity too. Time alone restores the budget; hammering while blocked does not extend the wait beyond one refill (30 s).

## Why legitimate intermittent sync is unaffected

A phone that reconnects after a day offline typically needs a handful of bootstrap pages, a few pull pages and push batches of 20: well inside the 60-challenge burst. A background sync every 15 minutes uses a few challenges and refills fully between runs. Clients already treat `temporarily_unavailable` with `retryable: true` (and any 5xx) as "try later": Android visit sync and bootstrap map it to RETRYABLE (WorkManager exponential back-off); iOS bootstrap maps it to retryable. iOS visit sync (`VisitSyncClient`) does not yet read 429 as retryable: it stops the run with "Unexpected sync response" and tries again on the next trigger. Only an identity that has already sent 10 rejected requests can see a 429, so a healthy phone never reaches it; a native follow-up should map 429/`temporarily_unavailable` to retryable and honour `Retry-After`. The v1 error `code` set is frozen, so no new code was added; `Retry-After` is an additive HTTP header.

## Storage

`mobileRateLimits` holds one token-bucket row per key: `challenge:<deviceId>` and `failure:<identity tokenIdentifier>`. Rows are bounded by the number of devices and signed-in people, contain no key, token, location or proof material, and are not shown in any UI.

## Not covered (residual)

- `devices.bind` signature retries reuse one challenge for up to 60 s (a failed signature never consumes the nonce, by design); they are bounded by the challenge rate and TTL but not individually counted, because a rejected Convex mutation cannot durably record its own failure.
- Unauthenticated floods (no valid bearer) are left to Convex platform limits; there is no IP-level throttle in Convex HTTP actions.
- Expired `deviceChallenges` rows are still not cleaned up automatically (needs a scheduled job; out of scope here).
- Values need security review and pilot telemetry before production.
