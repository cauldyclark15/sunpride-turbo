#!/usr/bin/env bash
# SP-0132: build the signed Sunpride Field (Beta) iOS app and copy it to
#   ~/cnc/_releases/sunpride/field-ios-beta/<version>/sunpride-field-ios-<version>.ipa  (+ .sha256)
# Run from the repo root: `bun run ipa:field-ios-beta`. Bump the build number with SUNPRIDE_BETA_BUILD=N;
# the version people see is 1.0.0-beta.N (CFBundleShortVersionString 1.0.0, CFBundleVersion N).
#
# Signing: jc's own paid team FV2R5JV6YD ("Apple Development"), automatic provisioning, development
# export (installs on phones registered to that team). Nothing is uploaded to App Store Connect or
# TestFlight — that needs jc's OK. Endpoints default to the beta backend in Config/Beta.xcconfig and are
# overridden by SUNPRIDE_BETA_CONVEX_SITE_URL / SUNPRIDE_BETA_CONVEX_URL / SUNPRIDE_BETA_WEB_URL.
#
# Optional: SUNPRIDE_BETA_INSTALL_UDID=<device udid> installs the exported app on that phone afterwards.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
OUT_ROOT="${SUNPRIDE_RELEASES_DIR:-$HOME/cnc/_releases/sunpride/field-ios-beta}"
BUILD="${SUNPRIDE_BETA_BUILD:-1}"
if ! [[ "$BUILD" =~ ^[1-9][0-9]{0,3}$ ]]; then
  printf 'SUNPRIDE_BETA_BUILD must be a whole number from 1 to 9999\n' >&2
  exit 1
fi
VERSION="1.0.0-beta.$BUILD"

check_url() { # name value suffix
  if [[ -n "$2" && ! "$2" =~ ^https://[a-z0-9.-]+$3/?$ ]]; then
    printf '%s must be an https URL ending in %s\n' "$1" "$3" >&2
    exit 1
  fi
}
check_url SUNPRIDE_BETA_CONVEX_SITE_URL "${SUNPRIDE_BETA_CONVEX_SITE_URL:-}" '\.convex\.site'
check_url SUNPRIDE_BETA_CONVEX_URL "${SUNPRIDE_BETA_CONVEX_URL:-}" '\.convex\.cloud'
check_url SUNPRIDE_BETA_WEB_URL "${SUNPRIDE_BETA_WEB_URL:-}" ''

overrides=("SUNPRIDE_BETA_BUILD=$BUILD")
[[ -n "${SUNPRIDE_BETA_CONVEX_SITE_URL:-}" ]] && overrides+=("CONVEX_SITE_URL=${SUNPRIDE_BETA_CONVEX_SITE_URL%/}")
[[ -n "${SUNPRIDE_BETA_CONVEX_URL:-}" ]] && overrides+=("CONVEX_URL=${SUNPRIDE_BETA_CONVEX_URL%/}")
[[ -n "${SUNPRIDE_BETA_WEB_URL:-}" ]] && overrides+=("FIELD_WEB_URL=${SUNPRIDE_BETA_WEB_URL%/}")

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sunpride-ios-beta.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="$WORK/FieldIOS-Beta.xcarchive"

xcodebuild archive -project "$PROJECT/FieldIOS.xcodeproj" -scheme FieldIOS-Beta -configuration Beta \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -allowProvisioningUpdates \
  "${overrides[@]}"

cat > "$WORK/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>debugging</string>
<key>teamID</key><string>FV2R5JV6YD</string>
<key>signingStyle</key><string>automatic</string>
<key>destination</key><string>export</string>
<key>compileBitcode</key><false/>
<key>stripSwiftSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$WORK/export" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -allowProvisioningUpdates

IPA="$(ls "$WORK"/export/*.ipa | head -1)"
APP="$ARCHIVE/Products/Applications/Sunpride Field (Beta).app"
PLIST_INFO="$APP/Info.plist"
read_key() { /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST_INFO"; }
# Refuse a build that is not the beta: wrong bundle, unexpanded or DEV/localhost endpoints, wrong version.
[[ "$(read_key CFBundleIdentifier)" == "com.sunpride.field.beta" ]] || { printf 'Not the beta bundle id\n' >&2; exit 1; }
[[ "$(read_key FIELD_VERSION_LABEL)" == "$VERSION" ]] || { printf 'Version label mismatch\n' >&2; exit 1; }
for key in CONVEX_SITE_URL CONVEX_URL; do
  value="$(read_key "$key")"
  if [[ ! "$value" =~ ^https://[a-z0-9-]+\.convex\.(site|cloud)$ ]]; then
    printf '%s is not a beta https Convex URL; refusing to publish.\n' "$key" >&2
    exit 1
  fi
done
codesign --verify --deep --strict "$APP"
TEAM="$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
[[ "$TEAM" == "FV2R5JV6YD" ]] || { printf 'Signed by team %s, expected FV2R5JV6YD\n' "$TEAM" >&2; exit 1; }

DEST="$OUT_ROOT/$VERSION"
mkdir -p "$DEST"
cp "$IPA" "$DEST/sunpride-field-ios-$VERSION.ipa"
(cd "$DEST" && shasum -a 256 "sunpride-field-ios-$VERSION.ipa" > "sunpride-field-ios-$VERSION.ipa.sha256")
printf 'Beta iOS app %s\n  %s\n' "$VERSION" "$DEST/sunpride-field-ios-$VERSION.ipa"

if [[ -n "${SUNPRIDE_BETA_INSTALL_UDID:-}" ]]; then
  xcrun devicectl device install app --device "$SUNPRIDE_BETA_INSTALL_UDID" "$APP"
fi
