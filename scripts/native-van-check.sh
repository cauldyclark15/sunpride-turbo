#!/usr/bin/env bash
# Van-sales POS native check (ADR-010): build, JVM tests and lint for apps/van-sales-android,
# then connected tests on the Senraise H10P handheld through the machine's lock-guarded
# handheld runner (installs app + test APK, keeps the app installed, removes only the test APK).
# Never runs connectedAndroidTest (AGP would target every attached device and uninstall the app).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/apps/van-sales-android"
if [[ ! -f "$PROJECT/gradlew" ]]; then
  printf 'Missing Android project/wrapper: %s\n' "$PROJECT" >&2
  exit 1
fi
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [[ ! -d "$JAVA_HOME" || ! -d "$ANDROID_HOME" ]]; then
  printf 'Android Studio JBR or SDK missing; see apps/van-sales-android/docs/SETUP.md.\n' >&2
  exit 1
fi

"$PROJECT/gradlew" -p "$PROJECT" :app:assembleDebug :app:testDebugUnitTest :app:lintDebug

# Device runner: VAN_DEVICE_TEST_SCRIPT overrides the default handheld runner location.
RUNNER="${VAN_DEVICE_TEST_SCRIPT:-$HOME/.hermes/scripts/sunpride-pos-device-test.sh}"
if [[ ! -x "$RUNNER" ]]; then
  printf 'No handheld runner at %s; skipping connected tests (unit tests already ran).\n' "$RUNNER" >&2
  exit 0
fi
set +e
"$RUNNER" "$ROOT"
code=$?
set -e
if [[ $code -eq 3 ]]; then
  printf 'Senraise H10P not connected; connected tests NOT run.\n' >&2
  exit 0
fi
exit $code
