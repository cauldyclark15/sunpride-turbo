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
# dev app and its data are never touched. It measures the signed-out first screen of a fresh install:
#   - APK size
#   - cold start (process killed, `am start -W` TotalTime = launch to first drawn frame) right after
#     install, and again after `cmd package compile -m speed-profile` (what Android does overnight)
#   - memory (TOTAL PSS) of the settled first screen
# Signed-in start-up, normal-work memory and real scrolling: scripts/measure-signed-in.sh.
# Results go to stdout and to ~/.hermes/cache/scratch/sp-lanes/perf-<label>-<time>.txt.
set -uo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${1:-run}"
RUNS="${RUNS:-10}"
SERIAL="${SUNPRIDE_ANDROID_SERIAL:-HD611L161114}"
OUT_DIR="$HOME/.hermes/cache/scratch/sp-lanes"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/perf-$LABEL-$(date +%Y%m%d-%H%M%S).txt"
# shellcheck source=perf-common.sh
source "$PROJECT/scripts/perf-common.sh"

require_phone
if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  "$PROJECT/gradlew" -p "$PROJECT" -q :app:assembleDevPerf || exit $?
fi
[[ -f "$APK" ]] || { echo "APK missing: $APK" >&2; exit 2; }

take_lock "perf-$LABEL"
cleanup() {
  [[ "${KEEP_PERF:-0}" == 1 ]] || adbs uninstall "$PKG" >/dev/null 2>&1
  rm -rf "$LOCK"
}
trap cleanup EXIT

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
say "APK size: $(apk_kb) KB"

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
say "Memory, settled first screen (TOTAL PSS): $(pss_mb) MB"
say "Saved: $OUT"
