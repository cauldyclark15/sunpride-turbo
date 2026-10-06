# Field app beta (SP-0124)

The first Sunpride beta ships the Android field app as a signed APK passed around by hand. iOS is
skipped this release. Anything not used in the beta yet is **hidden, not deleted**: the code, screens
and tests stay, and one list switches it back on.

## The beta feature list

`app/src/main/java/com/sunpride/field/FieldFeatures.kt` decides what a build shows.

| Feature             | What it is                                                                   | Beta     | How to switch it back on                              |
| ------------------- | ---------------------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| `VISITS`            | Start / End call, activities, call sheet, New order, review and send, photos | **On**   | (already on)                                          |
| `TEAM`              | Team page for supervisors (shown only to supervisors)                        | **On**   | (already on)                                          |
| `UNPLANNED_VISITS`  | "Unplanned visit" list on Today and the visit button on an off-plan outlet   | Hidden   | Remove it from `HIDDEN_IN_BETA`                       |
| `PHONE_KEY_DETAILS` | Key storage and fingerprint rows on Account (technical)                      | Hidden   | Remove it from `HIDDEN_IN_BETA`                       |
| `DEVELOPER_TOOLS`   | Writes the phone's public key to a file for `adb pull`                       | Dev only | Never in a release build (`DEVELOPER_ONLY`)           |
| "Report an issue"   | Account → opens the web tracker at `<web>/issues/new`                        | On       | Set `SUNPRIDE_BETA_WEB_URL`; hidden while it is empty |

To switch a hidden feature back on: delete its entry from `FieldFeatures.HIDDEN_IN_BETA`, rebuild with
`bun run apk:field-beta` (bump `SUNPRIDE_BETA_BUILD`), and hand out the new APK. `FieldFeaturesTest`
(JVM) and `FieldAppTest` (on the phone) cover the list, so update their expectations at the same time.

Why these are hidden:

- **Unplanned visits:** the client's rule (2 Oct 2026 call) is that a call is a store on the day's route
  plan, and new stores go through pre-enrolment and office approval, which the app does not do yet.
  Testers would otherwise record visits the office has no rule for.
- **Phone key details:** codes and ids testers can't act on. The phone code the admin needs is still on
  the "Register phone" screen and in Support info.

Other cleanup: an order the office has received now reads **Received by office** (the old "not yet
posted" wording implied the accounting system, which is out of scope this phase). The app has no links
to the retired PWA and no SAP wording.

## Debug gates and decisions

Before the beta, `MainActivity` passed `debug = BuildConfig.DEBUG && FLAVOR == "dev"` into `FieldApp`,
so every release build lost the visit flow. Each gate now:

| Gate (before)                                                                                              | Decision                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `FieldApp`: visit screen, activity forms, call sheet, order draft and review, photo capture behind `debug` | Product feature → `VISITS`, on in the beta release             |
| Today: tap a stop / Next store to open the visit (`diagnosticEnabled = debug`)                             | Product feature → `VISITS`                                     |
| Route and Customers: "Open visit" (`visitEnabled = debug`)                                                 | Product feature → `VISITS`                                     |
| Today "Unplanned visit" list (`diagnosticEnabled`)                                                         | `UNPLANNED_VISITS`, hidden in the beta (see above)             |
| `MainActivity.exportPublicKeyForDev` (public-key file)                                                     | Developer tool → `DEVELOPER_TOOLS`, debuggable DEV builds only |
| `SafeLog` Logcat events (`BuildConfig.DEBUG`)                                                              | Developer tool, unchanged: debug builds only                   |
| Photo screen "Test camera" (injected fake camera)                                                          | Test-only, unchanged: never set by the app                     |

There are no practice or stub backends in the Android app (those are iOS UI-test only).

## Building the beta APK

One time, create the beta signing key outside the repository:

```sh
bash apps/field-android/scripts/create-beta-keystore.sh
```

It writes `~/.sunpride-keys/field-beta.jks` and `~/.sunpride-keys/field-beta.properties` (chmod 600,
generated password, never printed). Keep both safe: every beta update must be signed with this same key
or testers have to uninstall (and lose unsent work). Point at another file with
`SUNPRIDE_BETA_SIGNING_PROPERTIES` in `local.properties` or the environment.

Then, from the repo root:

```sh
SUNPRIDE_BETA_BUILD=1 bun run apk:field-beta
```

The APK lands in `~/cnc/_releases/sunpride/field-beta/1.0.0-beta.N/` with a `.sha256` file. The script
refuses a debug-signed APK.

Settings (Gradle property, environment variable or `apps/field-android/local.properties`):

| Setting                            | Meaning                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `SUNPRIDE_BETA_CONVEX_SITE_URL`    | Beta backend site URL. Empty → the DEV value, with a build warning              |
| `SUNPRIDE_BETA_CONVEX_URL`         | Beta backend functions URL. Empty → the DEV value, with a build warning         |
| `SUNPRIDE_BETA_WEB_URL`            | Web app address for "Report an issue" (`/issues/new` is added). Empty → hidden  |
| `SUNPRIDE_BETA_BUILD`              | Build number N: version `1.0.0-beta.N`, version code N. Bump for every hand-out |
| `SUNPRIDE_BETA_SIGNING_PROPERTIES` | Path to the signing properties file (default `~/.sunpride-keys/...`)            |

The beta installs beside the DEV app as `com.sunpride.field.beta`, named "Sunpride Field (Beta)".
Every phone still needs an admin to register it (the "Register phone" screen) before it syncs.
