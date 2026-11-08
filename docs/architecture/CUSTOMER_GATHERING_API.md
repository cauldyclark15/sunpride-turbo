# Customer gathering API (SP-0162) — as built

Spec: `~/cnc/_plans/sunpride-inv-pos/CG-CONTRACT.md`. This note records only what the contract left open.

- **Errors** use the existing ApiError shape. Web (cookie) callers get `{"error":{"code","message","retryable"}}`;
  native (bearer) callers get the v2 envelope `{"version":2,"error":{"code","retryable","action"}}`.
  So `places/reverse` with no result is `404` code `not_found` (not a bare `{"error":"not_found"}`).
  `places_unavailable` is 503 when the key is missing, 502 on timeout (5 s) or a non-OK Google status;
  `rate_limited` is 429 after 60 proxy calls per person per minute (DB-backed fixed window, `rate_limits`).
- **Places proxy cache**: details and reverse answers are kept in memory for 24 h (reverse keyed on a ~1 m grid).
- **`census.capture` with `locationSource:"places"`** re-resolves `placeId` with Place Details inside the op.
  - Point more than 50 m from Google's, or the place is unknown: per-op result `rejected`, code `place_mismatch`.
  - Google unreachable / key missing: per-op result `{"status":"rejected","code":"places_unavailable","retryable":true}`.
    Nothing is stored and no receipt is written, so the phone keeps the op and sends the same op later
    (this is the sync engine's existing per-op `retryable` flag; Android's `DomainOutbox` already stops and keeps
    the op when `retryable` is true).
  - Stored coordinates are always the server's. `accuracy_meters` is null for address-search captures.
- **Idempotency**: the replay check runs before the Google call, so a replayed capture never needs Google.
- **`censusConfig.defaultBatch`** is `null` until the unit's first capture without a `batchId` creates
  `ONGOING-<unit code>` ("Ongoing store gathering", 1000 expected). Reads never create rows. When `batches` is
  empty, phones simply send no `batchId`.
- **Duplicate candidates** (`POST /api/v1/masters/census/duplicate-check`, also stored on each capture) come from
  active outlets in the caller's scope (current verified pin, contact phones, `outlets.place_id`) and unreviewed
  captures in scope. Rules are in `apps/api/src/domains/masters/duplicates.js`, tested against every fixture vector.
- **Office**: `GET /api/v1/masters/store-setup` (areas, channels, `addressSearch`), `POST /api/v1/masters/stores/office-add`
  (capability `outlet.manage`; uses `outletCommand create`, then a verified pin with source `office`; blank code →
  the SP-0082 customer code allocator), `GET /api/v1/masters/store-locations?missing=1&q=&limit=` (coverage counts).
- **Review**: `census/review` accept with a blank `code` allocates the next customer code; the response now includes `code`.
