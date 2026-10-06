# Sunpride Van handheld UI

Separate application: namespace `com.sunpride.van`, DEV package `com.sunpride.van.dev`. Only `devDebug` is enabled for debug. The field app is a read-only visual reference; its token values and system-bar setup are ported, not shared imports. No new dependency is required for the UI.

## Build

From `apps/van-sales-android`:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew assembleDebug testDebugUnitTest lintDebug
```

The existing `lintDebug` alias invokes `lintDevDebug`. This UI lane did not change Gradle configuration. Latest verification: exit **0**, `BUILD SUCCESSFUL in 4s`, `60 actionable tasks: 12 executed, 48 up-to-date`. JVM report: **104 tests, 0 failures, 0 errors, 0 skipped**. Four UI rules tests cover primary-action/status mapping, scaled quantity round trips and invalid input, discrepancy reasons, and start enablement.

## Office configuration

BuildConfig uses the existing flavor-specific `SUNPRIDE_DEV_CONVEX_SITE_URL` and `SUNPRIDE_DEV_CONVEX_URL` inputs. Never commit credentials or local configuration. If either origin is missing/invalid, the sign-in screen explains that setup is needed and disables sign-in. No raw endpoint errors, server errors, identity IDs, or request IDs are shown to salesmen.

Live gateway deployment/auth/device/bootstrap is owned by the core/backend lanes and is not claimed by this UI verification. See `ARCHITECTURE.md`.

## Isolated practice mode

The launcher accepts **only in DEBUG** the `VAN_STUB_BACKEND` intent extra, with `ready`, `unregistered`, or `revoked`. There is no on-screen switch to practice mode and no production bypass. For a manual practice launch:

```sh
"$ANDROID_HOME/platform-tools/adb" -s H10P756265T0744 shell am start \
  -n com.sunpride.van.dev/com.sunpride.van.MainActivity \
  --es VAN_STUB_BACKEND ready
```

Practice mode uses the existing fixture backend, independent encrypted database/session/device keys, and no server. It persists simulated progress across launches. UI device tests reset only the stub database and stub server preferences; they never clear real sales work. Most tests use the core worker factory's scheduling-disabled seam for deterministic explicit sync. The launcher smoke test uses the actual MainActivity and its intent-selected repository.

## Attached H10P verification

Do not use an emulator, `connectedAndroidTest`, or native field-app commands. Run all instrumentations only through the machine-locking helper:

```sh
~/.hermes/scripts/sunpride-pos-device-test.sh /Users/jc/cnc/.worktrees/sunpride-van-pos
```

Final run: exit **0**, **OK (34 tests)** on `H10P756265T0744`, including **9 UI/launcher tests** and all existing core/printer/scanner device suites. The printer suite intentionally sends one real, non-official test receipt. UI tests do not send a second receipt. Log:

`/Users/jc/.hermes/cache/scratch/sp-lanes/pos-test-sunpride-van-pos-232451.log`

All 23 full-screen PNGs are written using TARGET context `getExternalFilesDir`, not the test APK's context, to:

`/sdcard/Android/data/com.sunpride.van.dev/files/van-pos-shots/`

Pull them after the locked suite:

```sh
mkdir -p ~/.hermes/cache/scratch/sp-lanes/van-pos-shots
"$ANDROID_HOME/platform-tools/adb" -s H10P756265T0744 pull \
  /sdcard/Android/data/com.sunpride.van.dev/files/van-pos-shots \
  ~/.hermes/cache/scratch/sp-lanes/van-pos-shots
```

With that existing destination, adb places the files under `van-pos-shots/van-pos-shots/`. Final pull: **23 files, 0 skipped**. `UiAutomation.takeScreenshot()` captures the entire **720 × 1440 px** display, including status and three-button navigation bars; each capture asserts that full size. The helper hides the keyboard, waits for Compose/platform idle and settling, and checks the primary button's system-bar clearance, horizontal bounds and minimum 56dp height. Every final PNG was individually inspected with vision; all pass clearance, legibility and 360dp horizontal fit. See `SCREENS.md` for the per-file verdicts.

## Ownership and limits

UI/controller/launcher/tests/docs only. No changes to auth, device, storage, ledger, IDs, sync, diagnostics, data, printing or scanning packages. No core bug found. The UI never constructs a storage identity or bypasses repository rules. Selling/payment/returns/prices are intentionally absent; “New sale” is disabled. Printer service acceptance does not prove physical paper completion, optical scanning, or peso-glyph support; those existing limitations remain documented in `PRINTER_AND_SCANNER.md`.
