# Live location sharing (SP-0137)

The van POS shares the truck's position with the live map (web Field → Live map, SP-0135) **only while the trip is on the road**: from Start trip until the trip is closed on the handheld or the seller signs out. Never before, never after.

## What the seller sees

- **Consent, once** (per person and registered handheld; versioned by `LocationConsentText.VERSION`): before the first Start trip, the page "Sharing the truck's location" says what is collected, when, who sees it, why and for how long (Data Privacy Act of 2012, RA 10173). **Turn on location sharing** asks Android for the location (and, on Android 13+, notification) permission; **Not now** still starts the trip — selling is never blocked by GPS.
- **Indicator**: while the trip is on the road, Today shows **Location sharing on** (with "N waiting to send" when offline) or **Location sharing off** (tap to agree, to allow location, or to open Settings). The consent page also offers **Turn off location sharing** (consent withdrawn: sharing stops at once).
- **Notification**: an ongoing "Location sharing on" notification from the foreground service.

## How it works

| Piece                                                                                              | File                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Cadence, wire codec, rules, consent text                                                           | `location/LocationModel.kt`                |
| Consent store, permission check, service start/stop                                                | `location/LocationSharing.kt`              |
| Foreground service (type `location`, platform `LocationManager`, GPS + network — no Play services) | `location/TripLocationService.kt`          |
| Encrypted ping buffer (Room v9 `location_ping`)                                                    | `storage/LocationPingStore.kt`             |
| Upload (`POST /van/v1/location`, after the operations push)                                        | `sync/VanSync.kt`, `sync/VanSyncClient.kt` |
| Consent page and Today row                                                                         | `ui/LocationScreens.kt`                    |

- **Cadence** (mirrors `LOCATION_POLICY` in `packages/backend/convex/location/model.ts`): the first fix of a trip is `start`; while moving (≥ 1 m/s or ≥ 50 m from the last ping) every 60 s or after 50 m (`moving`); while still every 5 minutes (`still`); never two pings within 10 s; fixes worse than 500 m are skipped. Ending (trip closed here, trip no longer on the road, sign-out, consent withdrawn) records one `stop` at the latest position.
- **Each ping** carries latitude/longitude, accuracy, speed, heading, battery %, the mock-location flag, the provider, the device time (`recordedAt`) and the trip id; the server stamps its own time (`receivedAt`).
- **On the road** = the scope's trip is `active` on the server, or its `trip.start` is saved on this handheld, and it is not closed on this handheld. `LocationPingStore.record` checks this in the same transaction as the insert, so a late fix after close is never stored; the service then records `stop` and ends itself.
- **Buffer**: pings are frozen JSON in the encrypted SQLCipher database, scoped by person + handheld like the outbox. Accepted/duplicate rows are deleted at once; refused rows are never resent and are pruned with anything older than 7 days (the server refuses those as `too_old`).
- **Upload**: the sync worker (WorkManager, network required) sends batches of up to 100 after the operations push and the bootstrap, so the server already has the trip start; pings of a trip whose start the office has not acknowledged wait. The service asks for an upload at the first ping, after 5 pings or 5 minutes. A failed upload never fails the sales sync; it shows as "retry pending".
- **Restart**: the service is sticky and remembers its scope; opening the app re-checks the trip, consent and permission (also on every resume, so a permission granted in Settings is picked up).

## Decisions and limits (ours, Sunpride can change them)

- No background-location permission: the foreground service is started while the app is open. If Android kills the app and refuses a background restart, sharing resumes the next time the seller opens the app.
- Van tracking has no 10 PM cut-off (the field app's daily close); it follows the trip only. The server also accepts van pings only for an active trip.
- A trip started with no signal: pings recorded more than 5 minutes before the start reached the office are refused by the server (`trip_not_active`, its window starts at the server's `startedAt`). Trips are normally started at the depot with signal.
- The consent text is our own plain-words draft, not reviewed by Sunpride's data protection officer.
