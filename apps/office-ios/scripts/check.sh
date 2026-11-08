#!/usr/bin/env bash
# SP-0165: build the Office app and run its unit tests on an iPhone simulator (no network: the unit tests
# use URLProtocol stubs and real lane-captured fixtures). UI tests are live: see apps/office-ios/README.md.
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/OfficeIOS.xcodeproj"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [[ -z "${SIM_ID:-}" ]]; then
  SIM_ID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
for devices in json.load(sys.stdin)["devices"].values():
    for d in devices:
        if d["name"].startswith("iPhone 17") and d.get("isAvailable", True):
            print(d["udid"]); sys.exit(0)
sys.exit(1)')" || { printf 'No iPhone 17 simulator; set SIM_ID.\n' >&2; exit 1; }
fi
xcodebuild test -project "$PROJECT" -scheme OfficeIOS-Dev -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIM_ID" -only-testing:OfficeIOSTests
