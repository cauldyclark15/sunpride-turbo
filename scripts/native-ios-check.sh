#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/apps/field-ios/FieldIOS.xcodeproj"
if [[ ! -d "$PROJECT" ]]; then
  printf 'Missing iOS project: %s (integrate field-ios scaffold first).\n' "$PROJECT" >&2
  exit 1
fi
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
if [[ ! -d "$DEVELOPER_DIR" ]]; then
  printf 'Xcode not found at %s\n' "$DEVELOPER_DIR" >&2
  exit 1
fi

if [[ -z "${SIM_ID:-}" ]]; then
  SIM_ID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
for devices in json.load(sys.stdin)["devices"].values():
    for device in devices:
        if device["name"] == "iPhone 17 Pro" and device.get("isAvailable", True):
            print(device["udid"])
            sys.exit(0)
sys.exit(1)
')" || {
    printf 'No available iPhone 17 Pro simulator. Install a matching simulator or set SIM_ID.\n' >&2
    exit 1
  }
fi
if [[ -z "$SIM_ID" ]]; then
  printf 'SIM_ID is empty.\n' >&2
  exit 1
fi

for action in build test; do
  printf 'FieldIOS-Dev %s on simulator %s\n' "$action" "$SIM_ID"
  xcodebuild "$action" -project "$PROJECT" -scheme FieldIOS-Dev \
    -configuration Debug -destination "platform=iOS Simulator,id=$SIM_ID"
done
