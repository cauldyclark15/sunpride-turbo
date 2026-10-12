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

| Measure                                            | Before   | After                                            | Target     |
| -------------------------------------------------- | -------- | ------------------------------------------------ | ---------- |
| APK size                                           | 51.9 MB  | **15.6 MB** (16.0 MB with fragment 1.8.9, below) | < 25 MB ✓  |
| First launch right after install                   | 1,116 ms | **754 ms**                                       | —          |
| Cold start (median of 10)                          | 541 ms   | **470 ms**                                       | < 2.5 s ✓  |
| Cold start after Android's background optimisation | 537 ms   | **494 ms**                                       | < 2.5 s ✓  |
| Memory, settled first screen (PSS)                 | 91 MB    | **64 MB**                                        | < 250 MB ✓ |
| 600-outlet list: rows composed at once             | all 600  | **≤ 40** (only on screen)                        | lazy ✓     |

Cold start is `am start -W` TotalTime (process killed, launch to first drawn frame) on the
signed-out first screen: a fresh perf install has no account. Signed-in start-up does its storage
and network work off the main thread (SP-0139 keeps one encrypted database connection open), so
the first frame is the same screen work plus the Today layout.

List laziness is proven on the phone by `CustomerListPerformanceTest` (600 sample outlets: at most
40 rows composed at first, while flinging, and at the end of the list).

## Signed in with a sample account (2026-10-13, Redmi A7 Pro, release build)

`scripts/measure-signed-in.sh` on the same `devPerf` build, signed in as the beta sample sales tester
`sales@sunpride.test` (Rhea Santos, route `SMP-R-CBN-1`) against DEV, with an approved and activated
coverage plan from the beta sample data. "Usable Today" is Android's `Fully drawn` time: the app
reports it once the saved Today (work day, customers, visits, sales) is on screen
(`FieldController.launchSettled` → `ReportDrawnWhen`); the server check then runs behind it.

| Measure (median of 5 cold starts)                                    | Result                                                       | Target     |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ---------- |
| Cold start signed in, first frame                                    | 465 ms                                                       | —          |
| Cold start signed in, **usable Today**                               | **1,543 ms**                                                 | < 2.5 s ✓  |
| Same after Android's background optimisation                         | 474 ms / **1,565 ms**                                        | < 2.5 s ✓  |
| Memory through normal work (Today, scroll, Customers, outlet, back)  | **72–87 MB** (peak 87 MB)                                    | < 250 MB ✓ |
| Memory in a visit with the call sheet open (smoke below)             | **56–71 MB**                                                 | < 250 MB ✓ |
| Scroll Today, 8 flings each way (966 frames)                         | **0.21 % janky**, p50 10 ms, p90 12 ms, p99 16 ms            | no jank ✓  |
| Scroll the call sheet product list, 8 flings each way (1,694 frames) | **0.12 % janky**, p50 13 ms, p90 21 ms, p95 36 ms, p99 57 ms | no jank ✓  |

Frame numbers are `dumpsys gfxinfo` after real `input swipe` flings on the release build ("janky" =
frames that missed their display deadline). The sample route has 10 stores and only the next three
days ship to the phone, so the Customers list (4 outlets) fits on one screen and is not scrolled; long
customer lists are covered by the 600-outlet laziness test above. The call sheet's p95/p99 frames (36/57 ms)
are the heaviest seen; no frame was dropped at the display deadline more than 0.12 % of the time.

## Release-build workflow smoke (2026-10-13, Redmi A7 Pro, shrunk `devPerf` build, DEV)

The first R8-shrunk build was driven through a real field workflow on the Redmi:

1. **Sign in** through the Sign in screen (sample account) → Register phone (key registered by the DEV
   admin) → first sync → Today. ✓
2. **Visit**: Customers → Aling Nena Sari-Sari Store → visit (purpose Sell) → location prompt →
   check-in → note → call sheet (one order quantity, saved) → outcome Completed → Review and end →
   Confirm end. The server accepted every step from this phone: `visit.checkIn`, three
   `visit.activity` (note, two call-sheet saves) and `visit.checkOut` (`processedMobileOperations`). ✓
3. **The smoke found a crash, fixed here**: the location permission prompt crashed every build
   ("Can only use lower 16 bits for requestCode"). Biometric 1.1.0 (SP-0128) pulled fragment 1.2.5,
   whose `FragmentActivity` rejects the request codes androidx.activity's launchers use. The app now
   declares fragment 1.8.9 (`gradle/libs.versions.toml`); `PermissionRequestCodeTest` guards it on the
   phone. Device tests had not caught it because they inject fake location providers.
4. **Location sharing**: see the next section. ✓ (after the fix there)

A second visit (Jun-Jun Minimart) measured memory inside a visit: **56 MB** in progress, **66 MB** with
the call sheet open, **70 MB** after scrolling it, **71 MB** back on the visit (TOTAL PSS); its check-in,
call sheet and check-out were accepted by the server too.

The smoke's visit is an _unplanned_ visit: the `perf` build (never shipped) switches on unplanned
visits (`FieldFeatures.forBuild(..., perf = true)`) because a freshly signed-up sample account cannot
have a plan for its first day. Planned and unplanned visits use the same capture, outbox, signing and
sync code.

Also found, filed separately (not a performance issue): the phone's Back key closes the app from any
inner page (SP-0141).

## Location sharing asleep under battery saver (2026-10-13, Redmi A7 Pro, release build)

Set up the way a rep would: Start day (5:00 AM, the earliest the work day allows) → "Keep sharing when
the app is closed" → Settings → _Allow all the time_ → Today card "Keep sharing on all day" → Xiaomi
battery saver → _No restrictions_ (the card then disappears) → Security → Background autostart on.
Then, with the phone still on its desk: **system battery saver on, screen off, Android forced into deep
Doze** (`dumpsys deviceidle force-idle`, the deepest sleep Android has), and the trail read back from
the server (`locationPings`).

**The run found that no Android location ping had ever reached the server — fixed here.**
`RequestSigner.PATHS` did not list `/mobile/v1/location` (SP-0136), so every upload stopped on the phone
before it was sent and the worker retried forever; the pings stayed buffered on the phone. Unit tests
and device tests had faked the upload. `RequestSignerTest.signsEveryGatewayPathTheAppUses` now covers
it. (iOS lists the path already.)

| Run (stationary on a desk, Wi-Fi)                         | Result                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 05:03–05:28, deep Doze + battery saver, before the fix    | Sharing never stopped: a ping recorded every **6 min**, buffered; all 6 delivered with their original times right after the fix was installed |
| 05:33–05:52, deep Doze + battery saver, with the fix      | Pings every **6 min**, each on the server **within the same minute** (upload lag 0.0 min)                                                     |
| Whole trail 05:00–05:48                                   | 8 pings past the start, **largest gap 6.0 min** (still cadence 5 min + Doze alignment)                                                        |
| App battery, Android's power model (19 min, with uploads) | **0.57 mAh** (location service) ≈ 1.8 mAh/hour ≈ **16 mAh for a 9-hour still day, 0.3 % of 5,960 mAh**                                        |
| App data (19 min, 3 uploads)                              | **65 KB** ≈ 21 KB per upload (sign-in token + challenge + signed POST, each a new HTTPS connection)                                           |

Battery is Android's per-app power estimate while the phone counted itself as on battery
(`dumpsys battery unplug`); the cable kept the real level at 100 %. Moving phones take a fix about
every minute and upload every 5 minutes, so data is higher: about 110 uploads ≈ **2–2.5 MB per
moving 9-hour day** for location (photos come on top: a few hundred KB each). This replaces the
earlier 0.5–1 MB estimate, which ignored the per-upload connection cost.

**Not measured here (needs a person, split into SP-0142):** a real carried day — moving between stores,
mobile data instead of Wi-Fi, a real battery curve from 100 %, and Xiaomi's own background killer on
an app that was _not_ set to No restrictions. The steps are below.

## Battery and data: one real day (SP-0142)

Charge the Redmi to 100 %, install the release build (`perf` or beta), sign in, follow the battery guide,
turn battery saver on, unplug, then:

```bash
PKG=com.sunpride.field.dev.perf apps/field-android/scripts/measure-day.sh start   # then Start day
# ... carry the phone through a normal work day ...
PKG=com.sunpride.field.dev.perf apps/field-android/scripts/measure-day.sh stop    # before charging
```

`stop` prints the app's battery share, the phone's total drain and the app's data (background /
on-screen, Wi-Fi / mobile). Read the location trail for the day (web live map, or `locationPings` for
the device) and record the largest gap. Record all of it here with the date and battery-saver setting.

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
- **Found by the release smoke and fixed**: location pings now upload (`/mobile/v1/location` added to
  `RequestSigner.PATHS`), and the location permission prompt no longer crashes (fragment 1.8.9).
- **"Fully drawn" at a usable screen** (`ReportDrawnWhen` on `FieldController.launchSettled`), so
  start-up can be timed to the usable Today, not just the first frame.

## Repeat the measurement

```bash
apps/field-android/scripts/measure-performance.sh <label>     # signed-out first screen, RUNS=10
SUNPRIDE_PERF_ACCOUNT=<file> apps/field-android/scripts/measure-signed-in.sh <label>   # signed in
apps/field-android/scripts/measure-day.sh start|stop          # battery and data over a stretch of work
```

`measure-performance.sh` builds `devPerf`, waits for the shared phone lock, installs
`com.sunpride.field.dev.perf` (taps Xiaomi's "Install via USB" confirmation), measures, and uninstalls
it again (`KEEP_PERF=1` keeps it). `measure-signed-in.sh` keeps the perf app installed and signed in:
the account file (mode 600, line 1 email, line 2 password, typed on the phone, never printed) is used
only when the app shows Sign in; on a new install it stops at Register phone (exit 6) and saves the
phone code, which an admin registers once for that account
(`mobile/devices:register`). The sample account also needs an approved, activated coverage plan with
visits in the next three days, or the phone downloads no outlets. The installed dev app and its data
are never touched. Results are saved under `~/.hermes/cache/scratch/sp-lanes/`.

The device-test script runs the debug build. The shrunk release build is checked by the signed-in
measure and the workflow smoke above; a library that loads classes by name needs a keep rule in
`app/proguard-rules.pro` (SQLCipher's JNI package is kept whole).
