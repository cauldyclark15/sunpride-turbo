# Van Sales beta (SP-0125)

Sunpride testers get the van app as a hand-delivered Android APK (iOS is not part of the van app). This page covers what the beta build shows, how it is built and signed, and how it was checked on the Senraise H10P.

## What testers see

| Area                                                       | Beta (release) build                                                        | DEV debug build                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| Sign in, register phone, Today, Check the load, Start trip | On                                                                          | On                                                    |
| Find product, scanning, Truck stock and damage, Customers  | On                                                                          | On                                                    |
| Printer & scanner test                                     | On (also from Sign in and Register phone, so a new handheld can be checked) | On                                                    |
| Password eye on Sign in                                    | On                                                                          | On                                                    |
| "New sale" row and "Selling comes in the next update"      | Hidden (`VanFeature.SELLING_PREVIEW`)                                       | Shown                                                 |
| Practice data (`VAN_STUB_BACKEND` intent extra)            | Impossible: debug-only (`VanFeature.DEVELOPER_TOOLS` + `BuildConfig.DEBUG`) | adb only                                              |
| Report an issue (Sign in and Today)                        | Shown when `SUNPRIDE_BETA_WEB_URL` is set; opens `<url>/issues/new`         | Shown when the flavor's `SUNPRIDE_DEV_WEB_URL` is set |

Hidden means switched off in `app/src/main/java/com/sunpride/van/VanFeatures.kt`; nothing is deleted. Remove an entry from `VanFeatures.HIDDEN_IN_RELEASE` to switch it back on.

Cleanup checked for the beta:

- **SAP wording:** the app shows none (only internal docs mention SAP).
- **Bluetooth printer settings:** none exist (VAN-015 not built); the H10P uses its built-in printer, so nothing to hide.
- **Unfinished screens:** selling placeholders hidden as above. Developer tools (practice data, debug logging in `SafeDiagnostics`) are debug-only.

### Password eye

The Sign in password is hidden by default. The eye button (accessible label "Show password" / "Hide password", 56dp target) reveals it. It hides again when the app is left (Home, Recents, screen off), when Sign in is pressed, and whenever the Sign in screen is left. The visibility is never saved; the password itself is never saved or logged (unchanged).

### Logo

The client's real logo (`packages/ui/assets/sunpride-logo.jpg`, same file as the web app) is used unchanged:

- **Launcher icon:** adaptive icon (`mipmap-anydpi-v26/ic_launcher*.xml`) whose background layer is the logo filling the visible 72dp of the 108dp layer, padded with the logo's own red; the foreground is empty, so the circle/squircle mask keeps the wordmark centred. Legacy PNGs for mdpi…xxxhdpi and the 512×512 listing icon (`app/src/main/ic_launcher-playstore.png`).
- **Splash:** Android 12+ SplashScreen API (`values-v31/themes.xml`): logo on the logo red (`#ED1D25`, sampled from the logo in sRGB). Android 10/11 start on the same red, so there is no white flash. `MainActivity` swaps in the app background after start.
- **Sign in:** the logo above the title.

Regenerate every icon after a logo change with `bash apps/van-sales-android/scripts/generate-launcher-icons.sh` (macOS, CoreGraphics via `swiftc`; no ImageMagick).

## Build the beta APK

Once per Mac, create the signing key outside the repo:

```bash
bash apps/van-sales-android/scripts/create-beta-keystore.sh
```

It writes `~/.sunpride-keys/van-beta.jks` and `~/.sunpride-keys/van-beta.properties` (chmod 600, holds the generated password; never printed, never committed). Keep both: every later beta must be signed with the same key or the handhelds cannot update without uninstalling (and losing unsent work). Back them up somewhere private.

Then, from the repo root:

```bash
SUNPRIDE_BETA_BUILD=1 bun run apk:van-beta
```

- Endpoints come from `SUNPRIDE_BETA_CONVEX_SITE_URL` / `SUNPRIDE_BETA_CONVEX_URL` (environment, Gradle property or `apps/van-sales-android/local.properties`). When either is empty the build prints `WARNING: SUNPRIDE_BETA_… is not set; the van beta build uses the DEV value.` and uses the DEV endpoint.
- `SUNPRIDE_BETA_WEB_URL` turns on Report an issue.
- App name **Sunpride Van Sales (Beta)**, package `com.sunpride.van.beta` (installs beside the DEV app), versionName `1.0.0-beta.N`, versionCode `N` (raise N for every new APK so phones update in place).
- The script refuses a missing key file, a key file that is not chmod 600, a debug-signed APK or a debuggable APK; it verifies the signature with `apksigner` and copies the APK plus a `.sha256` to `~/cnc/_releases/sunpride/van-beta/<version>/sunpride-van-<version>.apk`.

## Install on a handheld

1. Copy the APK to the handheld (USB, or `adb -s <serial> install -r sunpride-van-<version>.apk`).
2. Allow installing from that source when Android asks.
3. Open **Sunpride Van Sales (Beta)**, tap **Test printer & scanner**, print a test receipt.
4. Sign in with the tester account, send the phone code to the supervisor, wait for registration.

Updating: install the newer APK over the old one (same key, higher build number). Do not uninstall first: unsent work lives only on the phone.

## Device proof (Senraise H10P)

Recorded in the SP-0125 issue comment and lane report:

- Debug instrumentation through `~/.hermes/scripts/sunpride-pos-device-test.sh` (includes the password eye, beta feature list, pre-sign-in printer test and nav-bar clearance tests).
- The signed release APK installed with `adb install -r`, launcher/app drawer, splash and Sign in screenshots (`adb exec-out screencap -p`) checked for the 3-button navigation bar and an uncropped wordmark, and a test receipt printed from the release build.
