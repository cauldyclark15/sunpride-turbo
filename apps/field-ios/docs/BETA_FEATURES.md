# iOS field app beta (SP-0132)

The iOS field app now has the same beta setup as the Android field app (`apps/field-android/docs/BETA_FEATURES.md`,
SP-0124/SP-0126): a separate **Beta** build signed by jc's team, the Sunpride logo as icon and launch screen, a
show/hide password eye, **Report an issue** on Account, and one feature list that hides what the beta does not use.
Anything hidden is **hidden, not deleted**: the code, screens and tests stay, and one list switches it back on.

## The beta feature list

`FieldIOS/Sources/App/FieldFeatures.swift` decides what a build shows. DEBUG builds (the `Debug` configuration,
`com.sunpride.field.dev`) show everything; every other build (`Beta`, `Release`) shows the beta list.

| Feature           | What it is                                                                   | Beta       | How to switch it back on                    |
| ----------------- | ---------------------------------------------------------------------------- | ---------- | ------------------------------------------- |
| `visits`          | Start / End call, activities, call sheet, New order, review and send, photos | **On**     | (already on)                                |
| `team`            | Team page for supervisors (shown only to supervisors)                        | **On**     | (already on)                                |
| `unplannedVisits` | "Other outlets / Unplanned visit" on Today and the visit button off-plan     | Hidden     | Remove it from `FieldFeatures.hiddenInBeta` |
| `phoneKeyDetails` | Key storage and fingerprint rows on Account (technical)                      | Hidden     | Remove it from `FieldFeatures.hiddenInBeta` |
| `developerTools`  | Public-key file, design-token preview, in-process stub backends              | DEBUG only | Never in a non-DEBUG build                  |
| "Report an issue" | Account → opens `<web>/issues/new` in the browser                            | On         | `FIELD_WEB_URL`; hidden while it is empty   |

Why these are hidden (same reasons as Android):

- **Unplanned visits:** the client's rule (2 Oct 2026 call) is that a call is a store on the day's route plan;
  new stores go through pre-enrolment and office approval, which the app does not do yet.
- **Phone key details:** codes testers can't act on. The phone code the admin needs is still on the
  "Register phone" screen and in Support info.

To switch a hidden feature back on: delete it from `FieldFeatures.hiddenInBeta`, update `FieldFeaturesTests` and
the UI test `testBetaFeatureListHidesUnplannedVisitsAndKeyRowsButKeepsVisits`, and build a new beta (bump
`SUNPRIDE_BETA_BUILD`). DEBUG UI tests can launch with `-fieldBetaFeatures` to see exactly what the beta shows.

Other cleanup: an order the office has received now reads **Received by office** (the old "· not yet posted"
implied the accounting system, which is out of scope this phase). The app has no SAP wording and no links to the
retired PWA.

## Debug gates and decisions

Before SP-0132 the whole visit screen was compiled only into DEBUG builds, so a release build had no visit flow.

| Gate (before)                                                                                     | Decision                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `DiagnosticVisitScreen` (Start/End, activities, call sheet, order, photos) wrapped in `#if DEBUG` | Product feature → `visits`, on in the beta    |
| Today: tap a stop / Next / Now opens the visit (`#if DEBUG`)                                      | Product feature → `visits`                    |
| Route "Open visit" and Customers "Open / Continue visit" (`#if DEBUG`)                            | Product feature → `visits`                    |
| Today "Other outlets" unplanned list and Customers "Unplanned visit"                              | `unplannedVisits`, hidden in the beta         |
| Account "Key storage" / "Fingerprint" rows                                                        | `phoneKeyDetails`, hidden in the beta         |
| `PublicKeyExport` (public-key file), `DesignTokensPreview`, `StubBackend`, test failure hooks     | Developer tools / test-only: stay `#if DEBUG` |
| Photo screen fake camera, stub location, stub navigation apps                                     | Test-only, unchanged: DEBUG stub backend only |

## Logo, icon and launch screen

`swift apps/field-ios/scripts/generate-icons.swift` (from the repo root) regenerates everything from the client's
`packages/ui/assets/sunpride-logo.jpg`, resized only (never redrawn, recoloured or cropped), opaque (no alpha):

- `Assets.xcassets/AppIcon.appiconset`: every iPhone and iPad slot plus the 1024 px marketing icon (iOS applies
  its own rounded mask).
- `Assets.xcassets/SunprideLogo.imageset` (160 pt, 1x/2x/3x): the launch-screen image and the logo above Sign in.
- `Assets.xcassets/LaunchBackground.colorset`: the logo's own red `#EE1C25` (= `SunprideTokens.red`, the Android
  splash). `Info.plist` `UILaunchScreen` shows the logo centred on that red, inside the safe area.

The same icon is used by DEV and Beta.

## Building the beta

```sh
SUNPRIDE_BETA_BUILD=1 bun run ipa:field-ios-beta          # from the repo root
```

`apps/field-ios/scripts/build-beta.sh` archives the `FieldIOS-Beta` scheme (`Beta` configuration), exports a
development-signed app and copies it to `~/cnc/_releases/sunpride/field-ios-beta/1.0.0-beta.N/` with a `.sha256`.
It refuses a build whose bundle id is not `com.sunpride.field.beta`, whose endpoints are not HTTPS Convex URLs, or
that is not signed by team `FV2R5JV6YD`. Add `SUNPRIDE_BETA_INSTALL_UDID=<udid>` to install it on a registered
phone afterwards.

| Setting                         | Meaning                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `SUNPRIDE_BETA_CONVEX_SITE_URL` | Beta backend site URL. Unset → `https://impartial-canary-155.convex.site` (beta prod)       |
| `SUNPRIDE_BETA_CONVEX_URL`      | Beta backend functions URL. Unset → `https://impartial-canary-155.convex.cloud`             |
| `SUNPRIDE_BETA_WEB_URL`         | Web app for "Report an issue" (`/issues/new` is added). Unset → `https://sunpride.keepr.im` |
| `SUNPRIDE_BETA_BUILD`           | Build number N: shown as `1.0.0-beta.N`, `CFBundleVersion` N. Bump for every hand-out       |

Defaults live in `Config/Beta.xcconfig`; the script passes the environment values as build-setting overrides.
`CFBundleShortVersionString` stays numeric (`1.0.0`) because iOS requires it; the beta label `1.0.0-beta.N` is
`FIELD_VERSION_LABEL` and is what Account and Support info show.

The beta installs beside the DEV app as `com.sunpride.field.beta`, named "Sunpride Field (Beta)". Signing is
automatic with jc's own paid Developer team `FV2R5JV6YD` (identity "Apple Development"). A development-signed app
installs only on phones registered to that team (today: jc's iPhone). **Handing it to other testers needs jc's
decision:** register their phones' UDIDs in the team (ad hoc, up to 100 devices) or upload to TestFlight — nothing
is uploaded to App Store Connect or TestFlight without jc's OK. Every phone still needs an admin to register it on
the "Register phone" screen before it syncs.

## Tests

- `FieldIOSTests/FieldFeaturesTests.swift`: the beta list, DEBUG-only developer tools, the Report-an-issue URL
  rules (same cases as Android `FieldFeaturesTest`), the version label, the launch-screen configuration and red,
  the icon set (every size, opaque; simulator only because it reads the repo).
- `FieldIOSUITests`: `testPasswordEyeShowsAndHidesThenSignsIn`, `testAccountReportAnIssueIsShownWithTheTrackerLink`,
  `testBetaFeatureListHidesUnplannedVisitsAndKeyRowsButKeepsVisits`, and `testBetaScreenshots` (sign-in with and
  without the password shown, beta Today, Account, visit; light and dark).
