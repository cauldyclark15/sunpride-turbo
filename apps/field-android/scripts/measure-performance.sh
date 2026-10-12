#!/usr/bin/env bash
# SP-0140: repeatable performance measurement of the RELEASE field app on the reference phone
# (Xiaomi Redmi A7 Pro, HD611L161114). See docs/PERFORMANCE.md for what each number means.
#
# Usage (from anywhere):  apps/field-android/scripts/measure-performance.sh [label]
#   RUNS=10                         cold starts per phase (median reported)
#   SUNPRIDE_ANDROID_SERIAL=...     another phone (default: the Redmi)
#   SUNPRIDE_PHONE_LOCK=...         machine-wide phone lock shared with the device-test script
#   KEEP_PERF=1                     leave the perf app installed afterwards
#   SKIP_BUILD=1                    reuse the last built APK
#
# It builds the `devPerf` variant (the release build type, R8 + resource shrinking + Baseline
# Profile, debug-signed under the separate package com.sunpride.field.dev.perf), so the installed
# dev app and its data are never touched. It measures:
#   - APK size
#   - cold start (process killed, `am start -W` TotalTime = launch to first drawn frame) right after
#     install, and again after `cmd package compile -m speed-profile` (what Android does overnight)
#   - memory (TOTAL PSS) of the settled first screen
# Results go to stdout and to ~/.hermes/cache/scratch/sp-lanes/perf-<label>-<time>.txt.
set -uo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${1:-run}"
RUNS="${RUNS:-10}"
SERIAL="${SUNPRIDE_ANDROID_SERIAL:-HD611L161114}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
ADB="$ANDROID_HOME/platform-tools/adb"
LOCK="${SUNPRIDE_PHONE_LOCK:-$HOME/.hermes/cache/scratch/sp-lanes/android-phone.lock}"
PKG="com.sunpride.field.dev.perf"
ACTIVITY="$PKG/com.sunpride.field.MainActivity"
APK="$PROJECT/app/build/outputs/apk/dev/perf/app-dev-perf.apk"
OUT_DIR="$HOME/.hermes/cache/scratch/sp-lanes"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/perf-$LABEL-$(date +%Y%m%d-%H%M%S).txt"

say() { printf '%s\n' "$*" | tee -a "$OUT"; }
adbs() { "$ADB" -s "$SERIAL" "$@"; }

if ! "$ADB" devices | awk -v s="$SERIAL" '$1==s && $2=="device"{f=1} END{exit !f}'; then
  echo "PHONE_NOT_CONNECTED: $SERIAL" >&2; exit 3
fi

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  "$PROJECT/gradlew" -p "$PROJECT" -q :app:assembleDevPerf || exit $?
fi
[[ -f "$APK" ]] || { echo "APK missing: $APK" >&2; exit 2; }

# Same lock as sunpride-android-phone-test.sh: never measure while another lane uses the phone.
for i in $(seq 1 360); do
  if mkdir "$LOCK" 2>/dev/null; then echo "$$ perf-$LABEL" > "$LOCK/holder"; break; fi
  holder=$(awk '{print $1}' "$LOCK/holder" 2>/dev/null)
  if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  [[ "$i" = 1 ]] && echo "Phone busy ($(cat "$LOCK/holder" 2>/dev/null)); waiting..." >&2
  sleep 10
done
grep -q "^$$ " "$LOCK/holder" 2>/dev/null || { echo "Could not get phone lock" >&2; exit 4; }
cleanup() {
  [[ "${KEEP_PERF:-0}" == 1 ]] || adbs uninstall "$PKG" >/dev/null 2>&1
  rm -rf "$LOCK"
}
trap cleanup EXIT

median() { sort -n | awk '{a[NR]=$1} END{ if (NR==0) print "n/a"; else if (NR%2) print a[(NR+1)/2]; else print int((a[NR/2]+a[NR/2+1])/2) }'; }
start_ms() { adbs shell am start-activity -W -S -n "$ACTIVITY" 2>/dev/null | awk -F': ' '/TotalTime/{gsub(/\r/,"",$2); print $2}'; }
cold_starts() {
  local times=()
  for _ in $(seq 1 "$RUNS"); do
    adbs shell am force-stop "$PKG"; sleep 2
    t=$(start_ms); [[ -n "$t" ]] && times+=("$t")
    sleep 3
  done
  printf '%s\n' "${times[@]}" | median
  printf '%s ' "${times[@]}" > "$OUT_DIR/.perf-last-runs"
}

say "SP-0140 field app performance — $LABEL"
say "Phone: $(adbs shell getprop ro.product.marketname | tr -d '\r') ($SERIAL), Android $(adbs shell getprop ro.build.version.release | tr -d '\r')"
say "Commit: $(git -C "$PROJECT" rev-parse --short HEAD 2>/dev/null)$(git -C "$PROJECT" diff --quiet 2>/dev/null || echo ' (+ uncommitted changes)')"
say "Date: $(date '+%Y-%m-%d %H:%M %Z')"
say "APK size: $(( $(stat -f %z "$APK" 2>/dev/null || stat -c %s "$APK") / 1024 )) KB"

# Xiaomi asks "Install via USB?" on the phone for a new package; tap its Install button.
install_apk() {
  local log="$OUT_DIR/.perf-install.log"
  adbs install -r "$APK" > "$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 40); do
    sleep 1
    kill -0 "$pid" 2>/dev/null || break
    adbs shell uiautomator dump /sdcard/sp-perf-ui.xml >/dev/null 2>&1 || continue
    local xy
    xy=$(adbs shell cat /sdcard/sp-perf-ui.xml 2>/dev/null | tr '>' '\n' \
      | grep -E 'text="Install"' | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 \
      | sed -E 's/bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/\1 \2 \3 \4/' \
      | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
    [[ -n "$xy" ]] && adbs shell input tap $xy
  done
  wait "$pid"; local rc=$?
  adbs shell rm -f /sdcard/sp-perf-ui.xml >/dev/null 2>&1
  [[ $rc == 0 ]] || cat "$log" >&2
  return $rc
}
adbs uninstall "$PKG" >/dev/null 2>&1
install_apk || { echo "install failed" >&2; exit 5; }
# Notifications and location stay unrequested: the signed-out first screen is what is measured.
first=$(start_ms)
say "First launch after install: ${first:-n/a} ms"
sleep 5
# androidx.profileinstaller writes the Baseline Profile on first launch; nudge it so phase 2 sees it.
adbs shell am broadcast -a androidx.profileinstaller.action.INSTALL_PROFILE -n "$PKG/androidx.profileinstaller.ProfileInstallReceiver" >/dev/null 2>&1
sleep 2

cold=$(cold_starts)
say "Cold start, as installed (median of $RUNS): $cold ms  [runs: $(cat "$OUT_DIR/.perf-last-runs")]"
adbs shell cmd package compile -f -m speed-profile "$PKG" >/dev/null 2>&1
cold2=$(cold_starts)
say "Cold start, after background optimisation (median of $RUNS): $cold2 ms  [runs: $(cat "$OUT_DIR/.perf-last-runs")]"

adbs shell am force-stop "$PKG"; sleep 2
adbs shell am start-activity -W -n "$ACTIVITY" >/dev/null 2>&1
sleep 8
pss=$(adbs shell dumpsys meminfo "$PKG" | awk '/TOTAL PSS:/{print $3; exit} /^ *TOTAL /{print $2; exit}')
say "Memory, settled first screen (TOTAL PSS): $(( ${pss:-0} / 1024 )) MB"
say "Saved: $OUT"
