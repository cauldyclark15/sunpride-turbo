#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/apps/field-android"
if [[ ! -f "$PROJECT/gradlew" ]]; then
  printf 'Missing Android project/wrapper: %s (integrate field-android scaffold first).\n' "$PROJECT" >&2
  exit 1
fi
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export ANDROID_HOME="$HOME/Library/Android/sdk"
if [[ ! -d "$JAVA_HOME" || ! -d "$ANDROID_HOME" ]]; then
  printf 'Android Studio JBR or SDK missing; check JAVA_HOME and ANDROID_HOME in NATIVE_FIELD_DEV.md.\n' >&2
  exit 1
fi

"$PROJECT/gradlew" -p "$PROJECT" :app:assembleDevDebug :app:testDevDebugUnitTest
if [[ ! -x "$ANDROID_HOME/platform-tools/adb" ]]; then
  printf 'adb missing; skipping connected tests (unit tests already ran).\n' >&2
  exit 0
fi
# Only a fully online emulator qualifies; offline/unauthorized entries do not.
if "$ANDROID_HOME/platform-tools/adb" devices | awk '$1 ~ /^emulator-/ && $2 == "device" { found=1 } END { exit !found }'; then
  "$PROJECT/gradlew" -p "$PROJECT" :app:connectedDevDebugAndroidTest
else
  printf 'No online Android emulator; skipping connectedDevDebugAndroidTest.\n' >&2
fi
