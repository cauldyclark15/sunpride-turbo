# Redmi carried work day (SP-0142)

Status: **preparation only; no carried-day measurements have been collected by this lane.** A person must carry the reference Redmi between stores for a real work shift. A stationary desk test, simulated battery discharge, debug suite or projection from a short run does not satisfy this issue.

## Ownership and scope

jc needs to assign a carrier and a date, and reserve the Redmi for the day. A separately authorized device-test operator records the release candidate and captures the start/end evidence; an authorized office reviewer reconciles the location trail and delivered work. The carrier can be an internal tester: Sunpride policy sign-off or real customer data is not a prerequisite. Clearly mark any sample account or sample business records, even when the physical phone, movement, battery and mobile network are real.

This document does not authorize phone access from a lane whose brief forbids it. SP-0142's preparation lane must not install, build for installation, connect to, run commands against or change settings on any phone. No phone commands are provided here. Perform the actual day in a separately authorized device session, not by lifting this lane's restrictions.

## Targets and interpretation

The proposed, unsigned [F-025 baseline](../spec/nfr-baseline.md#f-0254-battery-per-shift) is the source of these numbers, not a claim that Sunpride has accepted them. Use it over older performance notes where their budgets differ.

| Measure             | Proposed target / required evidence                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phone endurance     | Start at 100%, unplugged; at least 30% remains after a real 10-hour shift, without charging.                            |
| App battery         | Under 15% per shift; retain Android's attributed app energy, capacity and the exact denominator used.                   |
| Data without photos | Under 25 MB per shift, from Android per-app counters.                                                                   |
| Data with photos    | Under 75 MB per shift; record photo count and actual bytes when available.                                              |
| Battery curve       | Battery Saver on, real screen-off periods, a timestamped battery reading every 15 minutes.                              |
| Location            | Real movement and stationary periods, production cadence, server receipt of recorded fixes, no new fixes after End day. |

Use decimal MB (bytes / 1,000,000); label MiB separately if Android displays it. App battery percentage of _consumed power_ is not percentage of a _full battery_. Record both when available. Our working interpretation of the app budget is attributed mAh / reported full capacity mAh × 100, explicitly an Android model estimate, not directly measured energy. Preserve the raw figures so the reviewer can also assess another interpretation. If attribution or capacity is unavailable, mark the app-energy result NOT MEASURED; do not infer it from total phone drain.

One day tests only the workload actually performed. A day with photos does not establish the separate no-photo budget unless reliable photo-byte attribution exists; do not subtract guessed photo sizes. First sign-in/bootstrap is recorded separately, before the shift baseline; ordinary refreshes and retries during work remain in the shift total.

## Prepare once, before departure

1. Copy the [blank day record](templates/REDMI_CARRIED_DAY_RECORD.md) to a private evidence folder outside the repository. Keep it labelled NOT RUN until collection starts.
2. Assign the carrier, device operator and office reviewer; record the date, shift window and the real route/workload. Reserve the shared Redmi through the existing device-lock procedure so no other lane installs, force-stops or tests it during the day. Do not hold a USB connection to retain the reservation.
3. Verify the assigned Redmi A7 Pro (`HD611L161114`), not a personal phone or emulator. Record Android version and build fingerprint privately.
4. Identify the exact accepted, shrunk release APK: source commit, package, version, APK SHA-256 and configured API origin. Do not substitute a debug build or a perf build with different feature flags for the shipped-candidate result. Installing or replacing it belongs to the authorized device session only.
5. Sign in with the assigned account using the supported path, complete device registration and first download, and confirm Today's intended work is available. Do not clear saved work, reset the phone or change identities for measurement convenience.
6. Confirm location consent and permissions through the app's existing guide. Record system Battery Saver, Xiaomi per-app restriction, autostart and background-location settings individually. System Battery Saver and Xiaomi's per-app restrictions are different settings.
7. Charge to 100%, finish the initial Wi-Fi download, then disconnect USB, charger and power bank. Use real mobile data during the route; record any Wi-Fi interval rather than hiding it.
8. Capture the initial battery level, time, app UID/package, Android per-app mobile and Wi-Fi counters, and app battery/energy accounting window. Counters must cover the same interval at start and end; do not reset them mid-run. Save the raw screenshots/exports with their times.
9. Start the work day using the normal app action and record its exact time in Asia/Manila. Confirm the first real location record reaches the authorized office view before departure.

Use the existing recommended battery-guide configuration for the main day, recording exactly what it is. The earlier performance notes also leave Xiaomi's _restricted-app_ background behavior unproven. If this day uses No restrictions, say so: it does not prove the restricted configuration. A separate restricted-setting check must not silently change the main day's settings or be called the same measurement.

## Carry the phone through normal work

1. Carry it physically between stores, using normal check-in, governed activities, any photos/orders and check-out. Record workload counts and movement/still intervals; do not create a large synthetic workload.
2. Leave it screen-off during ordinary travel and pauses, with Battery Saver on. Record the start/end of substantial screen-off periods; do not keep the app foregrounded just to make tracking pass.
3. Record actual battery level and time every 15 minutes, plus the first and final readings. Use an independently validated non-charging logger if available, otherwise brief manual observations; log those screen wakes as measurement overhead. Never invent missed readings or interpolate them as observed data.
4. Record signal loss/return, Wi-Fi use, photo capture/upload, screen-on work, app errors, crashes, restarts and changes to permissions or battery settings as they happen. Do not force Doze or simulate being unplugged.
5. Keep using the normal offline queue during naturally missing coverage. If sharing stops or work is refused, note the time and visible state before recovery; do not erase the failed interval by restarting the measurement.
6. Safety and saved work take precedence. If charging or other intervention becomes necessary, preserve the log, mark the endurance run interrupted and retain the reason. A shorter run can diagnose a problem but cannot pass the 10-hour target.

Do not combine this day with the separate full SIM-out route requirement. This issue measures mobile-data use as well as real carried location and battery.

## End and reconcile before charging

1. At shift end, while still physically unplugged, record the battery, app mobile/Wi-Fi counters, their accounting windows, app energy estimate/capacity and screen-on information. Capture the final counters before reconnecting USB; plugging in for collection can change battery accounting.
2. Tap End day and record the exact time. Capture pending, review and held counts, then let ordinary sync finish without discarding anything. Record any later data separately from the shift window.
3. Observe the office view for at least 10 minutes after End day (an engineering observation window, not a signed SLA). Distinguish late delivery of old buffered fixes from fixes _recorded after_ End day. The existing service can emit one final `stop` marker from its last position; identify it instead of classifying it as continued sampling.
4. Reconcile the carrier's workload with office-accepted visits/activities and photo acknowledgements. Report pending, rejected, review and held work separately; an HTTP success is not proof everything arrived.
5. Obtain the authorized v2 trail for the correct profile and Manila date. The current route is `GET /api/v1/location/trail?profileId=<profile-id>&date=<YYYY-MM-DD>` on the candidate's recorded origin. Use the person's scoped office account, never a token pasted into a report. Preserve its `truncated` flag; a truncated export is incomplete proof.
6. Have the authorized reviewer reconcile the assigned device's raw `location_pings` records when device identity or delivery lag is needed. The trail API is profile-level and exposes `recordedAt` but not `received_at` or device ID; it cannot alone prove either. Do not invent a field, use the retired backend's table names or claim a live-map screenshot proves a full day.
7. Preserve raw evidence outside the repository with restricted access: real routes, identifiers and location history are sensitive. Post only the redacted summary and safe artifact references on SP-0142. Release the phone reservation only after evidence collection is finished.

## Calculations and location review

Run calculations with a script or spreadsheet over the collected rows; keep that input and output. Do not fill absent measurements with zero.

- Elapsed shift: end time minus start time, with timezone retained. Battery drop is start level minus final level in percentage points, not app-attributed consumption.
- Per transport: end cumulative received+sent bytes minus the matching start counters. Keep mobile/Wi-Fi and foreground/background separate if available. Changed UID, reboot/reset, missing transport buckets, a different accounting window or negative deltas require investigation, not a zero-clamped pass.
- Report all app traffic, including challenges/authentication, retries and ordinary downloads; do not use payload size alone as Android data usage.
- Sort the assigned device's fixes by `recorded_at`; retain the original rows and deduplicate only exact replay identifiers. Report count, first/last fix, leading/trailing gaps to the work-day boundaries and the largest gap, separately for moving, stationary and screen-off periods.
- Current source cadence is approximately 60 seconds or 50 metres when moving, five minutes while still, with upload requests after five minutes or ten stored fixes. OS delivery and network availability can delay these. These are implementation settings, not a signed maximum-gap SLA. Explain every material gap against movement, screen state, signal and settings; absence of an agreed gap number does not turn missing tracking into a pass.
- Where raw receipt times are available, calculate delivery lag as `received_at - recorded_at`, separately from capture gaps. Delayed upload with retained original fixes is not a missing-location interval. A clock anomaly requires investigation.
- Record mock-location flags and accuracy quality. Sample master pins, mock coordinates and a desk-bound location trace are not physical-route proof.
- Confirm no new movement/still fixes were recorded after End day within the observation window. State that this proves only that observed boundary, not every out-of-hours scenario or a separate 10 PM automatic-close run.

Source references: [cadence](../../apps/field-android/app/src/main/java/com/sunpride/field/location/Pings.kt), [service and upload batching](../../apps/field-android/app/src/main/java/com/sunpride/field/location/LocationShareService.kt), [work-day boundaries](../../apps/field-android/app/src/main/java/com/sunpride/field/location/WorkDay.kt), and [v2 trail and stored timestamps](../../apps/api/src/domains/fieldsync/location.js). Check these again if the candidate changes.

## Existing helper is not a full-day collector

`apps/field-android/scripts/measure-day.sh` is a historical start/stop diagnostic, not the acceptance procedure. Source review found that it resets battery statistics, defaults to the perf package, stores mutable start state and has no 15-minute sampler or lock acquisition. Its network parser maps every non-mobile transport to Wi-Fi and depends on Android's raw output format. It does not establish an authentic unplugged curve or complete transport accounting. Do not run it unreviewed, extrapolate its short-run output to a day or change it in this documentation-only lane.

## Acceptance and current blocker

Use the blank record to report each measure as PASS, FAIL or NOT MEASURED against the proposed targets. Include exact candidate, raw artifact references, formulas, workload, restrictions and all interventions. Preparation passes only document checks; it must never be reported as physical acceptance.

Current status remains **NOT MEASURED** for carried battery, shift data and moving location continuity. jc must assign the carrier/date and arrange the separate authorized device session. Keep SP-0142 out of In QA until actual evidence has been collected and reviewed; a shorter or charged run remains partial evidence, not a completed work day.
