# SP-0251 — store locations without a signal

## What changed

Saving a new customer does not wait for a location request. The saved reading, if there is one, travels with the customer; otherwise the customer is saved without a made-up pin. A separate location attempt runs for up to 15 minutes after the save. The resumable attempt is committed with the customer and draft removal, before the screen can close; it does not depend on a later screen callback. Better readings are kept as separate encrypted work and can send after the original customer when connectivity returns. Starting another store's location attempt replaces the previous attempt; any readings already saved remain queued.

A location attempt stops after a sufficiently accurate reading (15 m), expiry, detected vehicle travel (over 2.5 m/s), or movement over 150 m from its starting/first measured point. These are software defaults, not a Sunpride policy. Without any starting position, proximity cannot be established until the first reading arrives; test this case carefully before field acceptance.

Field readings still go through the normal office pin verification. An office-confirmed pin is never silently moved by a delayed phone reading. Admins and managers may correct the pin directly on the website within their existing permitted areas; historical pin coordinates are preserved.

## Small field check (not yet performed on physical phones)

1. Download the customer setup while connected. Turn off mobile data and Wi-Fi, leaving Location on. Open Customers > Add customer.
2. Fill the required customer details and photo. While location is still being obtained, save. Confirm the customer is kept without waiting for GPS.
3. Remain at the store, outside or near the door. Put the app in the background. Confirm a later reading is kept, and the attempt stops within 15 minutes (earlier for a good reading or detected departure).
4. Restore connectivity and sync. Confirm the customer arrives once, followed by its location. In the office, verify the proposed location and confirm the next phone download has the pin.
5. Repeat where no reading can be obtained at all. Reopen the saved customer or its saved-customer entry on the next visit. Confirm “Location not tagged yet” and tap “Tag location now”. A denied location permission must never prevent saving the customer.
6. On the website, open Customers > New customers > Store locations. Search for a missing-pin store, choose Set location, click its position on the map and save. Open a tagged store, choose Move pin, drag or click its new position and save. Check that ordinary read-only users get neither action.
7. Confirm a delayed phone upload cannot move a pin already corrected by the office, and a salesman cannot tag another person's private capture or a store outside their current area.

Waiting tip: “Go outside or near the door; GPS works without signal but needs a clear sky.”

## Platform and proof limits

Android uses the platform GPS provider, not fused/network location, for these attempts. Its location foreground service starts while the app is open, with a visible notification and no background-location permission. An app relaunch resumes an unexpired encrypted session; force-stop can prevent further sampling until relaunch, without deleting already queued readings.

iPhone/iPad Field work is on hold. This lane does not change, build or test an iOS target. GPS reception, background continuity, battery behaviour and delivery after reconnecting still require the Android field checks above; automated fixtures do not prove those physical conditions.

## Automated checks

- API: `bun run typecheck`, then `SP_LANE=sp251 SP_TEST_PORT=5010 SP_TEST_CONCURRENCY=1 bun run test harness-lifecycle customer-field-capture census-gathering census-duplicates customer-master`. Use the authorized lane URL for `DATABASE_URL`. On a host where the app role cannot install extensions, prepare extensions in this lane's database only and set `SP_TEST_TEMPLATE_DB=sunpride_lane_sp251`; the harness rejects any other template. Do not change shared template databases or role privileges.
- Web: `bunx tsc --noEmit`, `bunx vitest run src/components/store-gathering/store-pin-editor.test.tsx src/components/store-gathering/location-search.test.tsx`, and `bun run lint`. These are component/handler checks, not a real map-provider browser walkthrough.
- Android: `./gradlew assembleDevDebug testDevDebugUnitTest lintDevDebug compileDevDebugAndroidTestKotlin` using the authorized JDK 17 and Android SDK. The extra compilation checks the retained Room rollback/reopen assertions without running them on a device. JVM tests cover GPS-only selection, best-reading retention, expiry/departure, immutable follow-up work and upload dependencies; they do not simulate satellite reception or Android service scheduling.
