#!/usr/bin/env bash
# SP-0140: signed-in performance of the RELEASE field app on the reference phone (Redmi A7 Pro):
# cold start to a usable Today, memory through normal work, and real scrolling frame times.
#
# Usage:  apps/field-android/scripts/measure-signed-in.sh [label]
#   SUNPRIDE_PERF_ACCOUNT=<file>    mode-600 file: line 1 sample email, line 2 its password. Used only when
#                                   the perf app shows Sign in; the password is typed on the phone, never printed.
#   RUNS=5                          cold starts per phase (median reported)
#   FLINGS=8                        flings each way per scrolled list
#   SKIP_BUILD=1                    reuse the last built devPerf APK
#   SUNPRIDE_ANDROID_SERIAL / SUNPRIDE_PHONE_LOCK as in measure-performance.sh
#
# Unlike measure-performance.sh this KEEPS the perf app (com.sunpride.field.dev.perf) installed and
# signed in: its phone key is registered once for the sample account (docs/PERFORMANCE.md). The dev
# app is never touched. Exit 6 = the phone must be registered first (the key is saved, see output).
set -uo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${1:-signed-in}"
RUNS="${RUNS:-5}"
FLINGS="${FLINGS:-8}"
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
trap 'adbs shell rm -f "$UI_XML" >/dev/null 2>&1; rm -rf "$LOCK"' EXIT

say "SP-0140 field app signed-in performance — $LABEL"
say "Phone: $(adbs shell getprop ro.product.marketname | tr -d '\r') ($SERIAL), Android $(adbs shell getprop ro.build.version.release | tr -d '\r')"
say "Commit: $(git -C "$PROJECT" rev-parse --short HEAD 2>/dev/null)$(git -C "$PROJECT" diff --quiet 2>/dev/null || echo ' (+ uncommitted changes)')"
say "Date: $(date '+%Y-%m-%d %H:%M %Z')"
say "APK size: $(apk_kb) KB (release build type: R8 + resource shrinking)"
install_apk || { echo "install failed" >&2; exit 5; }   # -r: keeps the signed-in perf app's data

adbs shell am start-activity -W -S -n "$ACTIVITY" >/dev/null 2>&1
wait_text 'Today|Sign in|Register phone' 60 || { echo "app did not reach a known screen" >&2; exit 7; }

if ui_dump | grep -q 'text="Sign in"'; then
  [[ -n "${SUNPRIDE_PERF_ACCOUNT:-}" && -r "${SUNPRIDE_PERF_ACCOUNT:-}" ]] || {
    echo "Signed out: set SUNPRIDE_PERF_ACCOUNT to the sample account file" >&2; exit 6; }
  fields=$(ui_dump | grep 'class="android.widget.EditText"')
  email_xy=$(sed -n 1p <<<"$fields" | center_of); pass_xy=$(sed -n 2p <<<"$fields" | center_of)
  adbs shell input tap $email_xy; adbs shell input text "$(sed -n 1p "$SUNPRIDE_PERF_ACCOUNT")"
  adbs shell input tap $pass_xy; adbs shell input text "$(sed -n 2p "$SUNPRIDE_PERF_ACCOUNT")"
  adbs shell input keyevent KEYCODE_BACK   # hide the keyboard
  sleep 1; xy=$(ui_dump | grep -F 'text="Sign in"' | tail -1 | center_of); adbs shell input tap $xy   # the button, not the title
  say "Signed in through the Sign in screen ($(sed -n 1p "$SUNPRIDE_PERF_ACCOUNT"))"
  wait_text 'Today|Register phone|Turn on' 60
  tap_text "Not now" 2>/dev/null || true   # fingerprint offer: measured without the system prompt
fi
if ui_dump | grep -q 'text="Register phone"'; then
  tap_text "Show full code"; sleep 1
  ui_dump | grep -oE 'text="M[A-Za-z0-9+/=]{60,}"' | head -1 | sed -E 's/text="(.*)"/\1/' > "$OUT_DIR/perf-public-key.txt"
  echo "Register this phone for the sample account (public key saved to $OUT_DIR/perf-public-key.txt), then rerun." >&2
  exit 6
fi
# First sync after sign-in or registration downloads the day; wait for the outlets to be saved.
wait_text 'Search customers' 120 || { echo "Today did not load" >&2; exit 7; }
for _ in $(seq 1 60); do ui_dump | grep -qE 'outlets saved on this phone' && break; sleep 2; done
say "Today: $(ui_dump | grep -oE 'text="[0-9]+ outlets saved on this phone"' | head -1 | sed -E 's/text="(.*)"/\1/')"

# --- Cold start to a usable Today: first frame (TotalTime) and "Fully drawn" (saved Today on screen).
fully_ms() {  # parse "+1s234ms" / "+734ms" from the latest Fully drawn line
  adbs logcat -d -s ActivityTaskManager:I 2>/dev/null | grep "Fully drawn $PKG" | tail -1 \
    | grep -oE '\+([0-9]+s)?[0-9]+ms' | sed -E 's/\+//; s/s/ /; s/ms//' \
    | awk '{ if (NF==2) print $1*1000+$2; else print $1 }'
}
signed_in_starts() {
  local first=() usable=()
  for _ in $(seq 1 "$RUNS"); do
    adbs shell am force-stop "$PKG"; sleep 2; adbs logcat -c
    t=$(start_ms); [[ -n "$t" ]] && first+=("$t")
    for _ in $(seq 1 20); do u=$(fully_ms); [[ -n "$u" ]] && break; sleep 0.5; done
    [[ -n "${u:-}" ]] && usable+=("$u"); u=""
    sleep 4
  done
  echo "first frame $(printf '%s\n' "${first[@]}" | median) ms [${first[*]}]; usable Today $(printf '%s\n' "${usable[@]:-}" | median) ms [${usable[*]:-}]"
}
say "Cold start signed in, as installed (median of $RUNS): $(signed_in_starts)"
adbs shell cmd package compile -f -m speed-profile "$PKG" >/dev/null 2>&1
say "Cold start signed in, after background optimisation (median of $RUNS): $(signed_in_starts)"

# --- Normal work: Today -> scroll Today -> Customers -> scroll -> search -> outlet -> back. PSS after each step.
gfx_reset() { adbs shell dumpsys gfxinfo "$PKG" reset >/dev/null 2>&1; }
gfx_report() {
  adbs shell dumpsys gfxinfo "$PKG" | tr -d '\r' | awk '
    /^Total frames rendered:/ {t=$4} /^Janky frames:/ {j=$3" "$4}
    /^50th percentile:/ {p50=$3} /^90th percentile:/ {p90=$3} /^95th percentile:/ {p95=$3} /^99th percentile:/ {p99=$3}
    END { if (t == 0) printf "no frames drawn (the list fits on one screen; nothing to scroll)";
          else printf "%s frames, janky %s, p50 %s p90 %s p95 %s p99 %s", t, j, p50, p90, p95, p99 }'
}
fling_list() {
  local w h; read -r w h < <(adbs shell wm size | awk -F'[: x]+' '/Physical/{print $3, $4}')
  local x=$((w / 2)) lo=$((h * 3 / 4)) hi=$((h / 4))
  gfx_reset
  for _ in $(seq 1 "$FLINGS"); do adbs shell input swipe $x $lo $x $hi 120; sleep 0.7; done
  for _ in $(seq 1 "$FLINGS"); do adbs shell input swipe $x $hi $x $lo 120; sleep 0.7; done
  sleep 1; gfx_report
}
peak=0; note_pss() { local m; m=$(pss_mb); (( m > peak )) && peak=$m; say "  $1: ${m} MB PSS"; }

adbs shell am force-stop "$PKG"; sleep 2
adbs shell am start-activity -W -n "$ACTIVITY" >/dev/null 2>&1
wait_text 'Search customers' 30; sleep 3
say "Normal work (memory = TOTAL PSS after each step):"
note_pss "Today settled"
say "  Scroll Today ($FLINGS flings each way): $(fling_list)"
note_pss "after scrolling Today"
tap_text "Search customers"; wait_text 'Customers' 15; sleep 2
say "  Scroll Customers list ($FLINGS flings each way): $(fling_list)"
note_pss "Customers list after scrolling"
row=$(ui_dump | grep -E 'clickable="true"' | grep -vE 'text="(‹|Customers)"' \
  | awk -F'bounds="' '{print $2}' | awk -F'[][,]' '$3 > 400 && $6 < 1300 {print $2, $3, $5, $6}' | sed -n 2p \
  | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
[[ -n "$row" ]] && { adbs shell input tap $row; sleep 3; note_pss "outlet detail open"; adbs shell input keyevent KEYCODE_BACK; sleep 2; }
adbs shell input keyevent KEYCODE_BACK; sleep 2
note_pss "back on Today"
say "Peak memory through normal work: ${peak} MB PSS (budget 250 MB)"
say "Saved: $OUT"
