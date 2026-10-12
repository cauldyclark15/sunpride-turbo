#!/usr/bin/env bash
# SP-0140: battery and mobile data of the field app over a stretch of work (a full day, or a shorter
# bounded run), on the reference phone. Read-only on the app: it never installs, signs in or taps.
#
# Usage:  apps/field-android/scripts/measure-day.sh start   # at the start of the day (unplugged)
#         apps/field-android/scripts/measure-day.sh stop    # at the end of the day (before charging)
#   PKG=com.sunpride.field.beta     the app to account for (default: the perf build)
#   SIMULATE_UNPLUGGED=1            (bounded desk runs only) count the phone as on battery while it is
#                                   on the USB cable; `stop` restores it. A real day needs no cable.
#   SUNPRIDE_ANDROID_SERIAL=...     another phone (default: the Redmi)
#
# start: resets Android's battery statistics and saves the app's network byte counters.
# stop:  prints the app's estimated battery use (mAh, Android's power model) next to the phone's
#        total, and the app's data since start, split into background and on-screen, Wi-Fi and mobile.
set -uo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERIAL="${SUNPRIDE_ANDROID_SERIAL:-HD611L161114}"
OUT_DIR="$HOME/.hermes/cache/scratch/sp-lanes"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/day-$(date +%Y%m%d-%H%M%S).txt"
# shellcheck source=perf-common.sh
source "$PROJECT/scripts/perf-common.sh"
PKG="${PKG:-com.sunpride.field.dev.perf}"
STATE="$OUT_DIR/.day-$PKG"
require_phone

uid=$(adbs shell cmd package list packages -U "$PKG" | tr -d '\r' | awk -v p="package:$PKG" '$1==p {sub("uid:","",$2); print $2}')
[[ -n "$uid" ]] || { echo "$PKG is not installed" >&2; exit 2; }

# Sum rb/tb of the app's tag-0 (total) buckets: "<set> <transport> <rx> <tx>" per set and network type.
net_bytes() {
  adbs shell dumpsys netstats --poll >/dev/null 2>&1
  adbs shell dumpsys netstats detail | tr -d '\r' | awk -v uid="$uid" '
    /ident=\[/ { cur = ""; if ($0 ~ ("uid=" uid " set=") && $0 ~ /tag=0x0$/) {
        match($0, /set=[A-Z]+/); set = substr($0, RSTART + 4, RLENGTH - 4)
        net = ($0 ~ /type=0/) ? "mobile" : "wifi"; cur = set " " net } next }
    cur != "" && /rb=/ { for (i = 1; i <= NF; i++) { split($i, kv, "="); if (kv[1] == "rb") rx[cur] += kv[2]; if (kv[1] == "tb") tx[cur] += kv[2] } }
    END { for (k in rx) print k, rx[k], tx[k] }'
}

battery() { adbs shell dumpsys battery | tr -d '\r' | awk '/^ *level:/{print $2; exit}'; }

case "${1:-}" in
  start)
    adbs shell dumpsys batterystats --reset >/dev/null
    [[ "${SIMULATE_UNPLUGGED:-0}" == 1 ]] && adbs shell dumpsys battery unplug
    net_bytes > "$STATE"
    date +%s > "$STATE.time"
    echo "Started $(date '+%H:%M') for $PKG (uid $uid); battery $(battery)%"
    ;;
  stop)
    [[ -f "$STATE" ]] || { echo "run 'start' first" >&2; exit 2; }
    started=$(cat "$STATE.time"); mins=$(( ($(date +%s) - started) / 60 ))
    say "SP-0140 field app day measure — $PKG (uid $uid), $mins min, $(date '+%Y-%m-%d %H:%M %Z')"
    say "Phone: $(adbs shell getprop ro.product.marketname | tr -d '\r') ($SERIAL); battery saver: $(adbs shell settings get global low_power | tr -d '\r'); battery $(battery)%"
    adbs shell dumpsys batterystats > "$OUT_DIR/.day-batterystats.txt"
    awk -v uid="$uid" '
      /Estimated power use \(mAh\)/ { on = 1 } on && /Capacity:/ { print "  Estimated: " $0 }
      on && /Computed drain:/ { print "  Phone total: " $0 }
      on && $0 ~ ("UID u0a" (uid - 10000) ":") { print "  This app: " $0; on = 0 }' "$OUT_DIR/.day-batterystats.txt" | tee -a "$OUT"
    now=$(net_bytes)
    say "  Data since start (bytes received / sent):"
    awk 'NR==FNR { rx0[$1" "$2] = $3; tx0[$1" "$2] = $4; next }
         { k = $1" "$2; printf "    %-10s %-6s %9d / %9d\n", ($1 == "DEFAULT" ? "background" : "on-screen"), $2, $3 - rx0[k], $4 - tx0[k];
           t += ($3 - rx0[k]) + ($4 - tx0[k]) } END { printf "    total %.1f KB\n", t / 1024 }' "$STATE" - <<<"$now" | tee -a "$OUT"
    [[ "${SIMULATE_UNPLUGGED:-0}" == 1 ]] && adbs shell dumpsys battery reset
    say "Saved: $OUT"
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 64 ;;
esac
