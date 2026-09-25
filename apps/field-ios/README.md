# Sunpride Field (iOS DEV scaffold)

SwiftUI field app (DEV). Implemented: Better Auth email sign-in (session in Keychain, Convex JWT in memory), device key (Secure Enclave; simulator uses a TEST-ONLY Keychain key), request signer, and the enrollment flow (show public key → admin registers → `mine` → challenge → bind). Storage and sync are **not implemented** yet. The status pill shows `Offline — not signed in`, `Signed in — checking phone`, `Signed in — phone not registered`, `Ready` or `Phone removed`; it never claims data is synced.

## Build and test

Requires Xcode 27 and an available iOS 26+ simulator. From the repository root:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcrun simctl list devices available
SIM_ID=<available-iPhone-17-Pro-UUID>
xcodebuild build -project apps/field-ios/FieldIOS.xcodeproj -scheme FieldIOS-Dev -configuration Debug -destination "platform=iOS Simulator,id=$SIM_ID" CODE_SIGNING_ALLOWED=NO
xcodebuild test -project apps/field-ios/FieldIOS.xcodeproj -scheme FieldIOS-Dev -configuration Debug -destination "platform=iOS Simulator,id=$SIM_ID" -resultBundlePath "$TMPDIR/FieldIOS-Dev-$(date +%s).xcresult" CODE_SIGNING_ALLOWED=NO
```

Unit tests make no network calls (URLProtocol stubs) and load the frozen crypto vectors directly from `packages/domain-contracts/fixtures/mobile-v1/crypto/request-proof.json`. UI tests drive the real client code against a DEBUG-only in-process fake backend selected with the launch environment `FIELD_STUB_BACKEND=unregistered|registers|revoked` (stub password `correct-horse`; no real account). Simulator builds are ad-hoc signed (`CODE_SIGN_IDENTITY=-`, no team) because the Keychain needs an application-identifier entitlement.

Open `FieldIOS.xcodeproj` and select the shared `FieldIOS-Dev` scheme to run interactively. `project.yml` is the checked-in XcodeGen source; the generated `.xcodeproj` is also checked in, so XcodeGen is **not** required on a clean clone. After changing the project spec, regenerate from this directory with `xcodegen generate` and include the resulting project diff. Targets: `FieldIOS`, `FieldIOSTests`, `FieldIOSUITests`. Debug and Debug-Dev use `Config/Dev.xcconfig`.

`Dev.xcconfig` defaults to non-secret **localhost placeholders** for both URLs, so the shell can be previewed offline. For real DEV, create gitignored `Config/Local.xcconfig` with `CONVEX_SITE_URL = https:/$()/your-deployment.convex.site` and `CONVEX_URL = https:/$()/your-deployment.convex.cloud`. Xcode config uses `$()` to escape `//`. Both are exposed through Info.plist and validated by `AppEnvironment`; empty, malformed or non-HTTPS URLs (except localhost HTTP) produce a visible configuration error, not a crash. Never put credentials in config, build flags, screenshots or source. No signing team is required for simulator builds.

## Design

Native values follow `packages/ui/styles/index.css`, `sunpride.css` and `packages/ui/docs/DESIGN.md`, imported by the web globals stylesheet. Light canvas/surface `#F5F5F5`/`#FFFFFF`, dark `#060606`/`#181818`; ink/snow `#18181B`/`#FCFCFC`; accent red `#EE1C25`, yellow `#FEF200`, success `#2E9D59`, danger `#C8102E`. Spacing is 4-point based; radii 8/12. Web uses Mulish Variable, but this native scaffold uses the iOS system font and Dynamic Type until a licensed font artifact can be included. The debug-only **Design tokens** screen previews semantic states.

WCAG contrast (normal text, computed sRGB): white on brand red is **4.35:1** and white on yellow **1.17:1**, both below 4.5:1; neither is used for small text. Action buttons use white on darkened red `#B4151D` (**6.85:1**), warning status uses ink on yellow (**15.11:1**), success uses ink on green (**5.13:1**), danger uses snow on `#C8102E` (about **5.7:1**). Unit tests enforce >=4.5:1 on every text pair used in the scaffold, including both neutral themes. Yellow and red are not the only status cues: the pill has text and an icon.

## Live DEV sign-in and enrollment (manual)

1. Create gitignored `apps/field-ios/Config/Local.xcconfig`:
   ```
   CONVEX_SITE_URL = https:/$()/<deployment>.convex.site
   CONVEX_URL = https:/$()/<deployment>.convex.cloud
   ```
   Build and run `FieldIOS-Dev` on the simulator (Xcode, or `bun run native:ios` then `xcrun simctl install/launch booted com.sunpride.field.dev`).
2. Sign in with an invited employee account. The app shows "This phone isn't registered yet", the SPKI public key, fingerprint and model/OS/app version.
3. Tap **Copy public key**. In DEBUG builds this also writes `Documents/device-public-key.txt`:
   ```sh
   KEY_FILE="$(xcrun simctl get_app_container booted com.sunpride.field.dev data)/Documents/device-public-key.txt"
   ```
4. Admin registers it (own admin JWT, file mode 0600 outside the repo):
   `bun run packages/backend/scripts/register_device.ts --admin-jwt-file PATH --profile-id <employee profile ID> --app IOS --public-key-file "$KEY_FILE"`
5. Within 10 s the app finds the device, binds and shows **Phone ready**. Revoke with `--revoke DEVICE_ID --reason decommissioned`; the next check shows "This phone was removed — ask your admin".

The simulator key is a software key stored in the Keychain (key storage line says TEST ONLY); only a physical phone uses the Secure Enclave.
