# Sunpride Field (iOS DEV scaffold)

SwiftUI simulator-only shell. Authentication, device binding, storage and sync are **not implemented**; the Sign in button is deliberately disabled. The status pill is a placeholder and never claims data is synced. No network requests are made.

## Build and test

Requires Xcode 27 and an available iOS 26+ simulator. From the repository root:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcrun simctl list devices available
SIM_ID=<available-iPhone-17-Pro-UUID>
xcodebuild build -project apps/field-ios/FieldIOS.xcodeproj -scheme FieldIOS-Dev -configuration Debug -destination "platform=iOS Simulator,id=$SIM_ID" CODE_SIGNING_ALLOWED=NO
xcodebuild test -project apps/field-ios/FieldIOS.xcodeproj -scheme FieldIOS-Dev -configuration Debug -destination "platform=iOS Simulator,id=$SIM_ID" -resultBundlePath "$TMPDIR/FieldIOS-Dev-$(date +%s).xcresult" CODE_SIGNING_ALLOWED=NO
```

Open `FieldIOS.xcodeproj` and select the shared `FieldIOS-Dev` scheme to run interactively. `project.yml` is the checked-in XcodeGen source; the generated `.xcodeproj` is also checked in, so XcodeGen is **not** required on a clean clone. After changing the project spec, regenerate from this directory with `xcodegen generate` and include the resulting project diff. Targets: `FieldIOS`, `FieldIOSTests`, `FieldIOSUITests`. Debug and Debug-Dev use `Config/Dev.xcconfig`.

`Dev.xcconfig` defaults to non-secret **localhost placeholders** for both URLs, so the shell can be previewed offline. For real DEV, create gitignored `Config/Local.xcconfig` with `CONVEX_SITE_URL = https:/$()/your-deployment.convex.site` and `CONVEX_URL = https:/$()/your-deployment.convex.cloud`. Xcode config uses `$()` to escape `//`. Both are exposed through Info.plist and validated by `AppEnvironment`; empty, malformed or non-HTTPS URLs (except localhost HTTP) produce a visible configuration error, not a crash. Never put credentials in config, build flags, screenshots or source. No signing team is required for simulator builds.

## Design

Native values follow `packages/ui/styles/index.css`, `sunpride.css` and `packages/ui/docs/DESIGN.md`, imported by the web globals stylesheet. Light canvas/surface `#F5F5F5`/`#FFFFFF`, dark `#060606`/`#181818`; ink/snow `#18181B`/`#FCFCFC`; accent red `#EE1C25`, yellow `#FEF200`, success `#2E9D59`, danger `#C8102E`. Spacing is 4-point based; radii 8/12. Web uses Mulish Variable, but this native scaffold uses the iOS system font and Dynamic Type until a licensed font artifact can be included. The debug-only **Design tokens** screen previews semantic states.

WCAG contrast (normal text, computed sRGB): white on brand red is **4.35:1** and white on yellow **1.17:1**, both below 4.5:1; neither is used for small text. Action buttons use white on darkened red `#B4151D` (**6.85:1**), warning status uses ink on yellow (**15.11:1**), success uses ink on green (**5.13:1**), danger uses snow on `#C8102E` (about **5.7:1**). Unit tests enforce >=4.5:1 on every text pair used in the scaffold, including both neutral themes. Yellow and red are not the only status cues: the pill has text and an icon.
