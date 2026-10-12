# SP-0140: shared helpers for measure-performance.sh and measure-signed-in.sh (sourced, not run).
# Expects PROJECT, SERIAL, OUT_DIR and OUT to be set by the caller.

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
ADB="$ANDROID_HOME/platform-tools/adb"
LOCK="${SUNPRIDE_PHONE_LOCK:-$HOME/.hermes/cache/scratch/sp-lanes/android-phone.lock}"
PKG="com.sunpride.field.dev.perf"
ACTIVITY="$PKG/com.sunpride.field.MainActivity"
APK="$PROJECT/app/build/outputs/apk/dev/perf/app-dev-perf.apk"
UI_XML=/sdcard/sp-perf-ui.xml

say() { printf '%s\n' "$*" | tee -a "$OUT"; }
adbs() { "$ADB" -s "$SERIAL" "$@"; }

require_phone() {
  if ! "$ADB" devices | awk -v s="$SERIAL" '$1==s && $2=="device"{f=1} END{exit !f}'; then
    echo "PHONE_NOT_CONNECTED: $SERIAL" >&2; exit 3
  fi
}

# Same lock as sunpride-android-phone-test.sh: never measure while another lane uses the phone.
take_lock() {
  local label="$1"
  for i in $(seq 1 360); do
    if mkdir "$LOCK" 2>/dev/null; then echo "$$ $label" > "$LOCK/holder"; break; fi
    holder=$(awk '{print $1}' "$LOCK/holder" 2>/dev/null)
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
    [[ "$i" = 1 ]] && echo "Phone busy ($(cat "$LOCK/holder" 2>/dev/null)); waiting..." >&2
    sleep 10
  done
  grep -q "^$$ " "$LOCK/holder" 2>/dev/null || { echo "Could not get phone lock" >&2; exit 4; }
}

median() { sort -n | awk '{a[NR]=$1} END{ if (NR==0) print "n/a"; else if (NR%2) print a[(NR+1)/2]; else print int((a[NR/2]+a[NR/2+1])/2) }'; }
apk_kb() { echo $(( $(stat -f %z "$APK" 2>/dev/null || stat -c %s "$APK") / 1024 )); }

# The current screen as uiautomator XML, one node per line.
ui_dump() {
  adbs shell uiautomator dump "$UI_XML" >/dev/null 2>&1 || return 1
  adbs exec-out cat "$UI_XML" 2>/dev/null | tr '>' '\n'
}
center_of() { grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 \
  | sed -E 's/bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/\1 \2 \3 \4/' \
  | awk '{print int(($1+$3)/2), int(($2+$4)/2)}'; }
# Tap the first node whose text is exactly $1. Returns 1 when it is not on screen.
tap_text() {
  local xy; xy=$(ui_dump | grep -F "text=\"$1\"" | center_of)
  [[ -n "$xy" ]] || return 1
  adbs shell input tap $xy
}
# Wait up to $2 seconds (default 30) for a node whose text matches the ERE $1.
wait_text() {
  local deadline=$(( $(date +%s) + ${2:-30} ))
  while (( $(date +%s) < deadline )); do
    ui_dump | grep -qE "text=\"($1)\"" && return 0
    sleep 1
  done
  return 1
}

# Xiaomi asks "Install via USB?" on the phone for a new package; tap its Install button.
install_apk() {
  local log="$OUT_DIR/.perf-install.log"
  adbs install -r "$APK" > "$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 40); do
    sleep 1
    kill -0 "$pid" 2>/dev/null || break
    local xy; xy=$(ui_dump | grep -E 'text="Install"' | center_of)
    [[ -n "$xy" ]] && adbs shell input tap $xy
  done
  wait "$pid"; local rc=$?
  adbs shell rm -f "$UI_XML" >/dev/null 2>&1
  [[ $rc == 0 ]] || cat "$log" >&2
  return $rc
}

start_ms() { adbs shell am start-activity -W -S -n "$ACTIVITY" 2>/dev/null | awk -F': ' '/TotalTime/{gsub(/\r/,"",$2); print $2}'; }
pss_mb() {
  local kb; kb=$(adbs shell dumpsys meminfo "$PKG" | awk '/TOTAL PSS:/{print $3; exit} /^ *TOTAL /{print $2; exit}')
  echo $(( ${kb:-0} / 1024 ))
}
