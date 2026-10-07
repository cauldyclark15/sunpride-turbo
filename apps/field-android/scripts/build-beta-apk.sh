#!/usr/bin/env bash
# SP-0124: build the signed Sunpride Field beta release APK and copy it to
#   ~/cnc/_releases/sunpride/field-beta/<version>/sunpride-field-<version>.apk  (+ .sha256)
# Run from the repo root: `bun run apk:field-beta`. Bump the build number with SUNPRIDE_BETA_BUILD=N
# (env, Gradle property or local.properties); the version is 1.0.0-beta.N.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
SIGNING="${SUNPRIDE_BETA_SIGNING_PROPERTIES:-$HOME/.sunpride-keys/field-beta.properties}"
OUT_ROOT="${SUNPRIDE_RELEASES_DIR:-$HOME/cnc/_releases/sunpride/field-beta}"

if [[ ! -f "$SIGNING" ]]; then
  printf 'No beta signing key (%s). Create it once with:\n  bash apps/field-android/scripts/create-beta-keystore.sh\n' "$SIGNING" >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$SIGNING" 2>/dev/null || stat -c '%a' "$SIGNING")" != "600" ]]; then
  printf 'Refusing to use %s: it must be chmod 600.\n' "$SIGNING" >&2
  exit 1
fi

"$PROJECT/gradlew" -p "$PROJECT" --console=plain :app:assembleBetaRelease

APK_DIR="$PROJECT/app/build/outputs/apk/beta/release"
APK="$APK_DIR/app-beta-release.apk"
if [[ ! -f "$APK" ]]; then
  printf 'Signed APK missing (%s); check the signing properties.\n' "$APK" >&2
  exit 1
fi
VERSION="$(sed -n 's/.*"versionName": *"\([^"]*\)".*/\1/p' "$APK_DIR/output-metadata.json" | head -1)"
[[ -n "$VERSION" ]] || { printf 'Could not read versionName\n' >&2; exit 1; }

APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)"
"$APKSIGNER" verify --min-sdk-version 29 "$APK"
# Never ship a debug-signed APK as the beta.
if "$APKSIGNER" verify --print-certs "$APK" | grep -q 'CN=Android Debug'; then
  printf 'APK is signed with the debug key; refusing to publish.\n' >&2
  exit 1
fi

DEST="$OUT_ROOT/$VERSION"
mkdir -p "$DEST"
cp "$APK" "$DEST/sunpride-field-$VERSION.apk"
(cd "$DEST" && shasum -a 256 "sunpride-field-$VERSION.apk" > "sunpride-field-$VERSION.apk.sha256")
printf 'Beta APK %s\n  %s\n' "$VERSION" "$DEST/sunpride-field-$VERSION.apk"
