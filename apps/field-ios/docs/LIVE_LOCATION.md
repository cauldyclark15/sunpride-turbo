# Live location sharing (SP-0138)

The iOS field app shares the person's position with the live map (web Field → Live map,
`apps/web/docs/LIVE_MAP.md`) **only during the work day**. Backend and wire contract: SP-0135
(`packages/backend/convex/location/`, `POST /mobile/v1/location`, `locationRequest` in
`packages/domain-contracts/schemas/mobile-v1.schema.json`).

## When it runs

- **Starts** with **Start day** on Today, or automatically with the day's first call **Start**.
- **Stops** with **End day**, sign-out, or the 10 PM Manila daily close (the app ends the day 30 s
  before 10 PM so the final `stop` ping is still inside work hours; a day left open while the app
  was not running is closed at 10 PM the next time it runs).
- Never before 5 AM or after 10 PM Manila (the server refuses those pings as `outside_work_hours`).
- After End day the first call Start does **not** reopen the day; only Start day does.
- A held partition (phone removed, scope change under review) never shares.

## Consent and permission

- A one-time plain notice (Data Privacy Act) before the first Start day / first call: what is
  collected (position, accuracy, speed, direction, battery, time, simulated-location flag), when
  (work day only), who sees it (supervisors and managers in the person's area, head office), how
  long (90 days) and that declining keeps the app working. The answer is stored per account
  (SHA-256 of the auth subject in UserDefaults, never the subject itself). Declined → Today says
  so and **Start day** shows the notice again.
- Then iOS asks **While Using**, and once granted **Always** (`NSLocationAlwaysAndWhenInUseUsageDescription`
  explains why). While Using still shares in the background once started (blue status-bar
  indicator); Today hints to allow Always. Refused / Location Services off → Today shows
  "Location sharing off" with **Open Settings**; the app keeps working and the live map shows the
  person as offline.

## Visible indicator

- Top bar: **Location on** pill whenever sharing runs.
- Today → **Work day** card: "Location sharing on · Until End day or 10 PM · last <time> ·
  N waiting to send" with **End day**.
- iOS's own background location indicator (`showsBackgroundLocationIndicator = true`).

## Cadence and battery

- About one ping a minute while moving (speed ≥ 1 m/s), sooner after 50 m, one every 5 minutes
  while still, never under 10 s apart (server rate limit). `start` and `stop` pings mark the day.
- Core Location: `kCLLocationAccuracyNearestTenMeters`, 25 m distance filter, background updates
  allowed, automatic pausing off (the work day bounds the cost; the 5-minute still ping needs the
  updates alive), dropping to `kCLLocationAccuracyHundredMeters` after 2 minutes without movement
  and back on the next move, plus significant-change monitoring.
- Each ping: coordinates, accuracy, speed and heading (null when unknown), battery %, the
  simulated-location flag (`CLLocationSourceInformation.isSimulatedBySoftware`), provider `fused`,
  trigger, device time, and the open call's server visit ID when the call start was accepted. The
  server adds its own received time.

## Offline buffer and upload

- Pings go into the encrypted SQLCipher store (schema v8, table `location_pings`, partitioned by
  subject/device/scope like everything else; v7 → v8 only adds tables). The work day is the
  `work_days` table.
- Upload in signed batches of up to 100 (same device proof as visit sync) when 5 pings wait or
  5 minutes have passed, after every successful sync, and at End day. Every per-ping answer is
  final: `accepted` and `duplicate` are stored; `rejected` (outside hours, too old, too frequent…)
  will never be accepted, so it is dropped too. A network failure or refused proof keeps the
  whole batch with the same ping IDs for the next try (idempotent per device).
- Buffered pings older than 7 days are dropped on the phone (the server refuses them as
  `too_old`); the buffer holds at most 20,000 pings, newest kept.
- Sign-out records the `stop` ping and does not wait for the network: it stays encrypted in the
  account's (held) partition and is sent after the same account signs in again on this phone.

## Retention and visibility

Server-side, unchanged from SP-0135: 90-day scheduled cleanup; a person sees the people/trucks in
their current scope, sales only themselves, analyst read-only.

## Tests

- `FieldIOSTests/LiveLocationTests.swift`: work hours, sharing decision, cadence, wire shape
  against the shared `location-request.json` / `location-response.json` fixtures, invalid values,
  encrypted buffer (order, partition, held, v7 → v8 migration, ciphertext), signed upload (proof,
  every answered ping removed, failures keep pings, held skipped, 7-day drop), controller (consent
  flow, first call Start, End day, 10 PM close, outside hours, denied / While Using, sign-out),
  per-account hashed consent, consent wording.
- UI test `testLiveLocationConsentStartDayIndicatorAndEndDay` (stub backend with
  `FIELD_STUB_LIVE=1`, scripted fixes): notice, Start day, indicator, End day; light/dark
  screenshots. Other UI tests see the notice as already declined so it never interrupts them.

## Not proven here

- iOS delivering background updates for a full locked-phone work day, and relaunch after the
  system terminates the app, need a field day on a real phone with a real account.
