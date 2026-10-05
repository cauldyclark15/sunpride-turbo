# Mobile gateway abuse and rate controls (v1, QSR-009)

**Status:** implemented in `packages/backend/convex/mobile/rate_limits.ts`, wired into `mobile/devices:challenge`, `mobile/devices:bind` and the `/mobile/v1/*` HTTP actions. Verified with convex-test and HTTP-boundary unit tests (`rate_limits.test.ts`, `http_handlers.test.ts`); no live DEV or real-phone run yet. Values are engineering defaults, not signed client policy, and can be tuned in one place.

## What is bounded

| Control                      | Limit                                             | Where                                                                                  | On breach                                                                                                  |
| ---------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Request body                 | 128 KiB                                           | HTTP boundary, before parsing                                                          | 413 `invalid_request`                                                                                      |
| Push batch                   | 1–20 operations                                   | HTTP boundary, before proof                                                            | 400 `invalid_request`                                                                                      |
| Pull page                    | `limit` 1–50                                      | HTTP boundary                                                                          | 400 `invalid_request`                                                                                      |
| Bootstrap page               | `limit` 1–100                                     | HTTP boundary                                                                          | 400 `invalid_request`                                                                                      |
| Call sheet lines / dependsOn | 100 lines / 20 UUIDs per operation                | HTTP boundary                                                                          | 400 `invalid_request`                                                                                      |
| Signed request rate          | burst 60, then 1 per 2 s, per device              | `devices.challenge` (every signed bootstrap/pull/push and bind consumes one challenge) | Convex error `rate_limited`, no challenge issued                                                           |
| Invalid retries              | burst 10, then 1 per 30 s, per signed-in identity | HTTP actions and `devices.bind`, reserved atomically before any proof work             | 429 `temporarily_unavailable`, `retryable: true`, `Retry-After` seconds; bind: Convex error `rate_limited` |

"Invalid" means a request from a signed-in identity that the gateway rejects: malformed or oversized body (400/413), failed device proof, replayed nonce, wrong app or revoked/suspended phone (401), or a tampered/expired cursor (409 `invalid_cursor`). A legitimate `409 rebootstrap_required`, an over-budget working set (`413 invalid_request` from the QSR-013 bootstrap budget, which is the office's plan rather than the phone's fault), per-operation business rejections inside a 200 push response, and server errors (500) do **not** count. Requests without a valid bearer are rejected before any accounting (Convex validates the JWT).

**Reserve, then refund.** Every authenticated HTTP request first reserves one unit of its identity's budget in its own committed mutation (`rate_limits:reserve`), before reading the body or verifying any signature; a request that turns out legitimate gets the unit back (`rate_limits:refund`), a rejected one keeps it spent. A read-then-record design is not enough: N concurrent bad requests would all pass the read before any failure was recorded. Because Convex serializes the reservation, at most 10 requests (the burst) from one identity can be in proof verification at once, however many arrive together; the rest get 429 with no proof work. A tested regression sends 100 concurrent bad proofs: 10 reach authorization (401), 90 get 429. If the reservation itself cannot be written, the gateway fails closed with a 429.

`devices.bind` is a single public mutation, so a thrown error would roll back its own accounting. It therefore reserves the unit, consumes the one-time challenge, then verifies the signature; a bad proof, wrong/used/expired challenge or stale timestamp returns `{bindingStatus:"rejected"}` (not an error) so the spent unit and the burned challenge persist. A valid bind refunds the unit. Each challenge therefore admits at most one bind signature check, and when the budget is spent bind throws `rate_limited` before any signature work. Tested with 100 concurrent bad binds on one challenge: 10 `rejected`, 90 `rate_limited`, nothing bound. Native clients already treat anything other than `bound` as a failed bind and fetch a new challenge for the next attempt.

While an identity's invalid budget is spent, `devices.challenge` refuses that identity too. Time alone restores the budget; hammering while blocked spends nothing and does not extend the wait beyond one refill (30 s).

## Why legitimate intermittent sync is unaffected

A phone that reconnects after a day offline typically needs a handful of bootstrap pages, a few pull pages and push batches of 20: well inside the 60-challenge burst. A background sync every 15 minutes uses a few challenges and refills fully between runs. Clients already treat `temporarily_unavailable` with `retryable: true` (and any 5xx) as "try later": Android visit sync and bootstrap map it to RETRYABLE (WorkManager exponential back-off); iOS bootstrap and visit sync map HTTP 429, and a challenge refused with `rate_limited`, to a dedicated `throttled` result: queued work, the cursor and the last snapshot stay as they are, the run stops without an immediate retry (which would only be refused again), the screen says sync is busy and will try again shortly, and the next sync (foreground or background refresh, at least 15 minutes later — longer than any `Retry-After`) resumes normally. Only an identity that has already sent 10 rejected requests can see a 429, so a healthy phone never reaches it. The v1 error `code` set is frozen, so no new code was added; `Retry-After` is an additive HTTP header.

## Storage

`mobileRateLimits` holds one token-bucket row per key: `challenge:<deviceId>` and `failure:<identity tokenIdentifier>`. Rows are bounded by the number of devices and signed-in people, contain no key, token, location or proof material, and are not shown in any UI.

## Not covered (residual)

- Convex optimistic concurrency can execute a conflicting bind attempt's signature check before the transaction retries and sees the spent budget; committed outcomes are bounded exactly as above, executions only by Convex's own retry limit. The HTTP gateway has no such gap because its reservation is a separate committed transaction.
- Unauthenticated floods (no valid bearer) are left to Convex platform limits; there is no IP-level throttle in Convex HTTP actions.
- Expired `deviceChallenges` rows are still not cleaned up automatically (needs a scheduled job; out of scope here).
- Values need security review and pilot telemetry before production.
