# Field app performance on cheap phones (SP-0140, AND-PERF-001)

Sunpride's sales agents carry entry-level Android phones. The reference phone is jc's **Xiaomi
Redmi A7 Pro** (`HD611L161114`, Android 16, 4 GB RAM, 720×1600, 3-button navigation). Every Android
change must stay fast and light on it. Measure the **release build**, never debug.

## Budget

| What                                  | Target on the Redmi (release build)                                  |
| ------------------------------------- | -------------------------------------------------------------------- |
| Cold start to the first usable screen | under 2.5 s                                                          |
| Store / product lists                 | no dropped-frame jank (lazy lists, stable keys, no main-thread work) |
| Memory in normal use                  | under 250 MB                                                         |
| APK size                              | under 25 MB                                                          |
| Location sharing                      | stays on all day under Xiaomi battery saver                          |
| Offline sync                          | batched: one queued run, not one wake-up per saved row               |

## Measured (2026-10-13, Redmi A7 Pro, Android 16)

`scripts/measure-performance.sh` on the `devPerf` build (the release build type, debug-signed under
its own package). "Before" is main at `a8d484f` (release build had no shrinking); "after" is this change.

| Measure                                            | Before   | After                     | Target     |
| -------------------------------------------------- | -------- | ------------------------- | ---------- |
| APK size                                           | 51.9 MB  | **15.6 MB**               | < 25 MB ✓  |
| First launch right after install                   | 1,116 ms | **754 ms**                | —          |
| Cold start (median of 10)                          | 541 ms   | **470 ms**                | < 2.5 s ✓  |
| Cold start after Android's background optimisation | 537 ms   | **494 ms**                | < 2.5 s ✓  |
| Memory, settled first screen (PSS)                 | 91 MB    | **64 MB**                 | < 250 MB ✓ |
| 600-outlet list: rows composed at once             | all 600  | **≤ 40** (only on screen) | lazy ✓     |

Cold start is `am start -W` TotalTime (process killed, launch to first drawn frame) on the
signed-out first screen: a fresh perf install has no account. Signed-in start-up does its storage
and network work off the main thread (SP-0139 keeps one encrypted database connection open), so
the first frame is the same screen work plus the Today layout.

List laziness is proven on the phone by `CustomerListPerformanceTest` (600 sample outlets: at most
40 rows composed at first, while flinging, and at the end of the list). Frame timing was **not**
measured on the release build: a fresh perf install has no account, so it cannot reach the lists,
and frame metrics taken under the Compose test clock (debug build) are not a real-scroll measure.
Next step: a Macrobenchmark scroll test with a sample-data account on the release build (open item).

## What changed

- **R8 full mode + resource shrinking** for every release build (beta APKs included):
  `isMinifyEnabled`/`isShrinkResources`, `app/proguard-rules.pro`. Code went from 28 MB of dex to 4 MB.
- **Crash traces stay readable**: `bun run apk:field-beta` saves the R8 mapping, gzipped, to
  `~/cnc/_releases/sunpride/field-beta/mappings/` (outside the folder testers download).
- **ARM-only native libraries** in release builds (`arm64-v8a`, `armeabi-v7a`). The x86 copies of
  SQLCipher were 13 MB and only run on emulators. 32-bit ARM stays for the cheapest phones.
- **Baseline Profile** (`app/src/main/baseline-prof.txt`): the app's start-up, screen, store, sync
  and location code is compiled ahead of time on install (`androidx.profileinstaller`), on top of the
  profiles Compose and the other libraries ship.
- **Lossless WebP** for the logo, launcher and splash bitmaps (same pixels, about 40% smaller;
  `scripts/generate-icons.swift` now writes WebP).
- **Lazy customer list** with stable keys (`lazySectionCard` in `ui/CalmComponents.kt`): a territory
  of hundreds of outlets composes only the visible rows. Call sheet and order product lists were
  already lazy. Route and Today stay plain columns: they hold one day's stops (tens, not hundreds)
  and are composed once, so scrolling them does no work.
- **Less recomposition**: the customer and team screens follow a minute clock instead of the
  1-second sync-pill clock; Today and Route remember their computed summaries.
- **Batched background work** (`sync/work/CoalescedWork.kt`): visit sync, photo upload and location
  upload keep at most one queued run. Offline, each saved row used to append another run, so coming
  back online woke the phone dozens of times; now one run sends everything (location: batches of up
  to 100 pings). A run already in flight still gets exactly one follow-up, so nothing is left unsent.
- **Battery guide** for location sharing (`location/BatteryGuide.kt`, `AndroidBatteryGuide.kt`,
  `BatteryGuideScreen`): shown once per phone after location is set up (Start day), and offered again
  from the Today card ("Keep sharing on all day") while Android still restricts the app. It opens the
  brand's own page first (Xiaomi: app battery saver → _No restrictions_, Security → _Autostart_;
  OPPO/realme, vivo, Huawei/Honor, Infinix/Tecno/itel), then Android's battery-optimisation prompt,
  then the app's settings page. Location itself was already battery-light: balanced-power fixes,
  60 s / 50 m while moving, 5 min while still, delivered in batches.

## Data per work day (estimate)

A ping is about 350 bytes of JSON. A 9-hour day moving all the time is at most ~540 pings (≈190 KB),
sent every 10 pings or 5 minutes (~110 uploads with their signed-challenge round trip, a few KB each):
roughly **0.5–1 MB** of location data per day. Visit sync is a few KB per call. Photos dominate when
taken (about 2 MP JPEG at quality 85, a few hundred KB each). Measure a real day with
`adb shell dumpsys netstats detail` for the app's UID.

## Battery with location on (how to measure)

A full-day battery figure needs a person carrying the phone. On the Redmi: charge to 100%, unplug,
`adb shell dumpsys batterystats --reset`, start the day in the app, use the phone normally until
evening, then `adb shell dumpsys batterystats --charged com.sunpride.field.dev` (Estimated power use
per UID). Record the result here with the date and the battery-saver setting.

## Repeat the measurement

```bash
apps/field-android/scripts/measure-performance.sh <label>     # RUNS=10 by default
```

It builds `devPerf`, waits for the shared phone lock, installs `com.sunpride.field.dev.perf` (taps
Xiaomi's "Install via USB" confirmation), measures, and uninstalls it again (`KEEP_PERF=1` keeps it).
The installed dev app and its data are never touched. Results are saved under
`~/.hermes/cache/scratch/sp-lanes/perf-<label>-<time>.txt`.

The device-test script runs the debug build. The shrunk release build is checked by launching it
(above) and by the beta smoke test; a library that loads classes by name needs a keep rule in
`app/proguard-rules.pro` (SQLCipher's JNI package is kept whole).
