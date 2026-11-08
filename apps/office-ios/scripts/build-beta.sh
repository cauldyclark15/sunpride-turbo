#!/usr/bin/env bash
# SP-0165: build the signed "Sunpride Office (Beta)" app (com.sunpride.office.beta) and copy it to
#   ~/cnc/_releases/sunpride/office-ios-beta/<version>/sunpride-office-ios-<version>.ipa  (+ .sha256)
# Run from the repo root: `bun run ipa:office-ios-beta`. SUNPRIDE_BETA_BUILD=N sets the build number
# (version 1.0.0-beta.N). Signing: team FV2R5JV6YD, automatic, development export. Nothing is uploaded
# to App Store Connect or TestFlight. Server: Config/Beta.xcconfig, overridden by SUNPRIDE_BETA_API_URL.
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
OUT_ROOT="${SUNPRIDE_RELEASES_DIR:-$HOME/cnc/_releases/sunpride/office-ios-beta}"
BUILD="${SUNPRIDE_BETA_BUILD:-1}"
[[ "$BUILD" =~ ^[1-9][0-9]{0,3}$ ]] || { printf 'SUNPRIDE_BETA_BUILD must be 1-9999\n' >&2; exit 1; }
VERSION="1.0.0-beta.$BUILD"
ORIGIN="${SUNPRIDE_BETA_API_URL:-https://sunpride.cauldnclark.com}"
[[ "$ORIGIN" =~ ^https://[a-z0-9.-]+/?$ ]] || { printf 'SUNPRIDE_BETA_API_URL must be an HTTPS origin\n' >&2; exit 1; }
ORIGIN="${ORIGIN%/}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sunpride-office-beta.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="$WORK/OfficeIOS-Beta.xcarchive"
xcodebuild archive -project "$PROJECT/OfficeIOS.xcodeproj" -scheme OfficeIOS-Beta -configuration Beta \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -allowProvisioningUpdates \
  "SUNPRIDE_BETA_BUILD=$BUILD" "SUNPRIDE_API_ORIGIN=$ORIGIN"
cat > "$WORK/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>debugging</string>
<key>teamID</key><string>FV2R5JV6YD</string>
<key>signingStyle</key><string>automatic</string>
<key>destination</key><string>export</string>
<key>stripSwiftSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$WORK/export" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -allowProvisioningUpdates
IPA="$(ls "$WORK"/export/*.ipa | head -1)"
APP="$ARCHIVE/Products/Applications/Sunpride Office (Beta).app"
read_key() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Info.plist"; }
[[ "$(read_key CFBundleIdentifier)" == "com.sunpride.office.beta" ]] || { printf 'Not the beta bundle id\n' >&2; exit 1; }
[[ "$(read_key OFFICE_VERSION_LABEL)" == "$VERSION" ]] || { printf 'Version label mismatch\n' >&2; exit 1; }
[[ "$(read_key SUNPRIDE_API_ORIGIN)" == "$ORIGIN" ]] || { printf 'Server origin mismatch; refusing\n' >&2; exit 1; }
codesign --verify --deep --strict "$APP"
DEST="$OUT_ROOT/$VERSION"; mkdir -p "$DEST"
cp "$IPA" "$DEST/sunpride-office-ios-$VERSION.ipa"
(cd "$DEST" && shasum -a 256 "sunpride-office-ios-$VERSION.ipa" > "sunpride-office-ios-$VERSION.ipa.sha256")
printf 'Beta Office iOS app %s\n  %s\n' "$VERSION" "$DEST/sunpride-office-ios-$VERSION.ipa"
