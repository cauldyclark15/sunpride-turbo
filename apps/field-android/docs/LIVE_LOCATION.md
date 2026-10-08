# Live location sharing — Android field app (SP-0136)

The field app shares the salesperson's position with the office live map (SP-0135,
`apps/web/docs/LIVE_MAP.md`) **only during the work day**.

## When it runs

| Starts                                                              | Stops                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| "Start day" on the Today card                                       | "End day" on the Today card                                     |
| The day's first visit Start (check-in), if the person has consented | Sign-out                                                        |
| —                                                                   | 10 PM Manila daily close (automatic, also if the app is closed) |

- Never before 05:00 or after 22:00 Manila (the server refuses those pings too).
- A check-in never restarts sharing after the person tapped End day that day; they tap Start day
  again if they are working again. A new day starts fresh.
- Sharing needs the one-time consent for this person on this phone (keyed by their account, so a
  second person on the same phone consents for themselves).

## What the person sees

- **Consent screen** (once): what is collected, when, who sees it (supervisors/managers in their
  area; analysts read-only), 90-day retention, and that declining keeps the app working
  (Data Privacy Act, RA 10173). Buttons: "I agree" / "Not now".
- **Permissions**: Android's "while using the app" location (and notifications on Android 13+).
  Then an optional explanation screen for "Allow all the time" (Android 11+ opens Settings). That
  only lets Android restart sharing if it stopped the service while the app was closed.
- **Today → Work day card**: Start day / End day and the current state.
- **Top bar**: "Location sharing on" pill while sharing; "Location off" (warning) when the day is
  started but location permission is off.
- **Ongoing notification** "Sunpride is sharing your location for work" for the whole time the
  foreground service (type `location`) runs. It cannot be swiped away while sharing.

Denied permission: the app keeps working; the card offers "Allow location" (second tap opens the
app's Settings page). The office map shows the person with no recent position.

## How it works

- `location/LocationShareService.kt` — foreground service; `FusedLocationProviderClient` at
  balanced-power priority, 60 s interval, batched delivery (up to 3 min). It re-checks the work
  day on every fix and every minute, so End day, sign-out, revoked permission or 10 PM stop it.
- `location/Pings.kt` — `PingCadence`: ~60 s or 50 m (beyond the fix accuracy) while moving,
  every 5 min while still, never closer than 15 s (server floor 10 s). `PingCodec` builds the v1
  wire ping (accuracy, speed, heading, battery %, mock-location flag, device time; the server adds
  its own time), clamped to the server's ranges. `OpenVisit` attaches the open call's server visit
  ID once its Start is acknowledged.
- Pings are buffered in the encrypted SQLCipher store (table `location_pings`, schema v9),
  partitioned like the visit outbox; a held partition records and sends nothing. Pings older than
  7 days are dropped (the server would refuse them).
- `location/LocationUploader.kt` — signed `POST /mobile/v1/location` in batches of ≤100 through the
  same device-proof gateway as visit sync. Accepted/duplicate/refused pings leave the buffer;
  offline/5xx/malformed answers keep the exact bytes for the retry (same `clientPingId`, so the
  server de-duplicates). `LocationUploadWork` runs it when the phone is online (WorkManager,
  network-constrained, exponential backoff): on the first ping, every 10 pings or 5 minutes, and
  on stop.
- `location/WorkDay*.kt` — the work-day rules and state (pure, JVM-tested).

## Assumptions (our defaults, client may refine)

- Consent wording is ours, not reviewed by Sunpride legal/HR.
- Work hours 05:00–22:00 mirror the server (`LOCATION_POLICY`).
- "Location off" on the supervisor map: the v1 contract has no position-less "location off"
  signal, so a person who denied permission simply has no recent position (status Offline). A
  dedicated signal needs a contract addition (follow-up).
- No restart after a phone reboot (no boot receiver); opening the app resumes a running day.

## Tests

- JVM: `app/src/test/java/com/sunpride/field/location/` (work-day rules and host, cadence, wire
  fixture parity, uploader batching/retry/held/unauthorized).
- Phone (`~/.hermes/scripts/sunpride-android-phone-test.sh <worktree>`):
  `LiveLocationDeviceTest` (SQLCipher ping buffer, consent screen and buttons above the
  3-button navigation bar in light/dark, indicator, End day, location-off, ongoing notification)
  and `StoreMigrationTest` v8→v9. Screenshots are written to
  `/sdcard/Android/data/com.sunpride.field.dev/files/sp-0136/`.
