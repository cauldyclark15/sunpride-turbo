# Field app update announcements (SP-0245)

## What the person sees

Direct-APK builds check on opening/resuming the app and reconnecting, independently of sign-in and phone registration. An available newer version shows “New version available” with Update and Not now. Account > Check for updates offers the same update. Update opens the published download in the phone's browser; Android still asks the person to confirm installation. This is not a silent installer, and the app never clears saved work during an update.

A normal new build is optional. Only a deliberately set `minimum_supported_version_code` above the installed version blocks use. A failed/offline version check never invents a block. A previously confirmed required-update policy is retained on that phone until it updates or receives a newer policy. Already-current or newer versions show no notice. There is no daily version requirement.

Play builds retain the Google Play action and do not check the direct-APK announcement feed. An APK build subsequently installed by Google Play also keeps the Play path. Automatic Play updates remain controlled by Play and the user's settings; an APK announcement is not evidence that a version is available on Play.

Existing apps cannot acquire this new notice without first installing a build containing it. Distribute that first build once by the existing method; subsequent APK publications announce themselves.

## Distribution builds

- `bun run apk:field-beta` now selects `-PSUNPRIDE_APK_DISTRIBUTION=true`. It keeps the existing package, signing key and build number. Only this build compiles `app/src/apk/java` and its external download action.
- `./gradlew bundleBetaRelease` defaults to `app/src/play/java`, whose only update destination is Google Play. The build refuses any bundle task if `SUNPRIDE_APK_DISTRIBUTION=true` was supplied. Never upload the direct-distribution APK to Play; use the default bundle.
- Neither build requests `REQUEST_INSTALL_PACKAGES` or restores the retired shared APK downloader/installer.
- Dev verification of the APK-only action can use `./gradlew -PSUNPRIDE_APK_DISTRIBUTION=true assembleDevDebug testDevDebugUnitTest lintDevDebug`. Set the authorized JDK 17 and Android SDK as usual; no device is needed.

Google's policy requires Play-distributed apps to update only through Play: https://support.google.com/googleplay/android-developer/answer/16559646?hl=en . Source separation preserves the existing SP-0207 boundary; it is not a claim of Play review/approval.

## One-time integration setup (not performed by an isolated issue worker)

1. Before applying the updated deployment, provision `sunpride-app-release` in namespace `sunpride`, using the existing APK publisher's credential file. Keep credentials out of arguments, logs and source control:

   ```sh
   kubectl -n sunpride create secret generic sunpride-app-release \
     --from-file=SP_APP_RELEASE_TOKEN=/Users/jc/.sunpride-keys/system-agent-token \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

   The API trims the file's line ending, just as the existing publisher does. The credential must contain at least 32 characters and be usable as the existing bearer token. This credential is only accepted on the announcement-write route; it grants no app sign-in or customer-data access. An active Super Admin can also use that route through their normal authenticated session.

2. Apply the normal DB migrations, including `0849_field_app_updates.sql`, and ship the API with `deploy/k8s/30-api.yaml`. The manifest reads the dedicated secret into `SP_APP_RELEASE_TOKEN`. The optional secret reference allows older installations to start, but publication explicitly fails with 403 until configured; it never accepts unauthenticated publishers.
3. Build/distribute the first notice-capable APK through the normal job. No job edit is needed: `~/.hermes/scripts/sunpride-ops/release.py` already uploads/shares the APK and calls `POST /api/v1/apps/releases`, then verifies `GET /api/v1/apps/latest?app=field`. Those previously missing endpoints are now implemented. The job's `app`, `version_code`, `version_name`, `download_url`, `notes`, and `git_sha` payload works unchanged. Package defaults to `com.sunpride.field.beta`; other environments must explicitly supply `package_name`.
4. Check the normal job succeeds (including its exact metadata read-back), then open the installed APK app below that version and choose Update. Keep the lane's automated fixture evidence distinct from this real distribution check.

Publication is idempotent for the same version/details. Different details at an already-announced version are refused. Older or retried publications never replace the newest version. Only HTTPS Drive file-view links (including Google's `?usp=drivesdk` and `?usp=sharing` suffixes) or the owned Sunpride `/downloads/*.apk` paths are accepted; arbitrary download hosts, other query parameters and credential-bearing URLs are refused. Metadata is public so a signed-out/obsolete app can recover, and contains no people, devices or credentials. No-store responses avoid keeping stale compatibility policies.

`notified: 0` in the publisher response means no chat/push messages were sent. The app discovers the publication itself; this is not a fabricated notification-delivery count.

## When an old version really cannot work

For an intentional compatibility break, a trusted publisher may include `minimum_supported_version_code` in the new-version announcement. It must be an integer between 0 and that announcement's `version_code`. Do not set it to every new build: keep the previous floor unless old clients genuinely cannot work. An omitted floor inherits the newest policy (initially 0). A subsequent higher build can explicitly lower the floor if necessary; an already-published version cannot be silently edited. Never raise the floor without a working, reachable replacement signed for the same package.

No phone, live publication, Play upload, production secret change or production migration is performed by SP-0245's isolated checks.
