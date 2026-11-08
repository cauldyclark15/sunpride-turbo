# Customer gathering API (SP-0162) — as built

Spec: `~/cnc/_plans/sunpride-inv-pos/CG-CONTRACT.md`. This note records only what the contract left open.

- **Errors** use the existing ApiError shape. Web (cookie) callers get `{"error":{"code","message","retryable"}}`;
  native (bearer) callers get the v2 envelope `{"version":2,"error":{"code","retryable","action"}}`.
  So `places/reverse` with no result is `404` code `not_found` (not a bare `{"error":"not_found"}`).
  `places_unavailable` is 503 when the key is missing, 502 on timeout (5 s) or a non-OK Google status;
  `rate_limited` is 429 after 60 proxy calls per person per minute (DB-backed fixed window, `rate_limits`).
- **Places proxy cache**: details and reverse answers are kept in memory for 24 h (reverse keyed on a ~1 m grid).
- **`census.capture` with `locationSource:"places"`** never calls Google inside the sync op (review B2/SF2).
  - The capture is accepted (plain `applied`, never `retryable`) with the phone's point and a `census.resolvePlace`
    job is queued in the same transaction. Captures stay append-only; the job writes one `census_place_checks` row.
  - Location status (in `census-queue`): `pending` (no check yet: "Checking the address…", Approve refused with
    `location_pending`), `verified` (within 50 m; Google's point becomes the store pin), `mismatch` (over 50 m or the
    place is gone; both points shown; Approve needs `pinChoice: "device" | "place"`, else `location_mismatch`).
  - Google unreachable: the job retries with the jobs worker backoff (30 s doubling, 5 attempts), then re-queues an
    hour out. `accuracy_meters` is null for address-search captures.
- **Idempotency**: replays are answered from the receipt / prior capture; no Google call is involved.
- **`censusConfig.defaultBatch`** is `null` until the unit's first capture without a `batchId` creates
  the unit's ongoing batch ("Ongoing store gathering", 1000 expected), found by `is_default` (one per unit), never by
  code. Its code is `ONGOING-<unit code>`, or with a unit-id/random suffix if that code is already taken. Reads never create rows. When `batches` is
  empty, phones simply send no `batchId`.
- **Duplicate candidates** (`POST /api/v1/masters/census/duplicate-check`, also stored on each capture) come from
  active outlets in the caller's scope (current verified pin, contact phones, `outlets.place_id`) and unreviewed
  captures in scope. At capture time the scope is the batch unit's subtree. Stored candidates are re-filtered
  through the reader's current scope when `census-queue` is served. The check is limited to 60 per person a minute. Rules are in `apps/api/src/domains/masters/duplicates.js`, tested against every fixture vector.
- **Office**: `GET /api/v1/masters/store-setup` (areas, channels, `addressSearch`), `POST /api/v1/masters/stores/office-add`
  (capability `outlet.manage`; uses `outletCommand create`, then PROPOSES a pin with source `office` via `pinCommand`;
  a different person with `outlet.verify` confirms it under "Pin to confirm" (`outlets/pins/decide`); blank code →
  the SP-0082 customer code allocator), `GET /api/v1/masters/store-locations?missing=1&q=&limit=` (coverage counts).
- **Review**: `census/review` accept with a blank `code` allocates the next customer code; the response now includes `code`.
