# Sunpride Office (iOS) — SP-0165

Native office app for iPhone (portrait) and iPad (portrait and landscape), SwiftUI, iOS 26+ (built with
Xcode 27 / iOS 27 SDK). Design decisions: [DESIGN.md](DESIGN.md).

## What it does (phase 1)

| Section | Screens | Server (the same endpoints the web uses) |
|---|---|---|
| Today | figures, needs attention, people in the field, vans on the road, two-week sales | `GET /api/v1/analytics/today` |
| Decide | approvals inbox (filter by kind), item detail, approve / reject with the web rules (reason to reject, who carries a difference, idempotency key), recently decided; badge = items you can decide | `GET /api/v1/decide/inbox`, `POST /api/v1/decide/act` |
| Stores | search (server `q`), filter, paging, KPIs, location coverage (checked pins vs universe), store detail with map pin + Open in Maps, orders, visits, products; store gathering review when the queue has rows | `GET /api/v1/analytics/stores`, `/analytics/store`, `/location/store-pins`, `/masters/census-queue`, `POST /masters/census/review` |
| Stock | stock value, stock on hand (all or one place, product search), transfers list/detail, counts to review | `GET /api/v1/inventory/valuation`, `/inventory/locations`, `/inventory/transfers/list`, `/transfers/detail`, `/inventory/counts/mine` |
| More | Sales & targets, Vans & cash, Money, Coverage & people, Stores POS (registers + till days, X/Z readings, receipts), Issues, Account / sign out | `/analytics/{sales,vans,money,coverage}`, `/storepos/{workspace,days,z-readings}`, `/fiscal/receipts`, `/issues/board` |

Role-aware from `/api/me` capabilities: reports need `report.read`, Stock `inventory.read`, counts
`inventory.count.approve`, Stores POS `van.cash.approve`/`admin.manage`, Issues `issues.read`, location
coverage `location.read`, store gathering `outlet.verify`. The server still decides every action.

## Sign-in

`POST /api/auth/sign-in` with `{version: 2, app: "office-ios", email, password}` — native mode: a 7-day
session (Keychain only, this device, never synced) and a 15-minute access token (memory only), refreshed at
`/api/auth/refresh`; one shared refresh; a refused session signs out locally. Copied from the field app's
approach, not shared with it. The office app carries **no device key** (the server refuses one for
`office-ios`; it never registers a handheld). Server side: `apps/api/src/core/auth.js`, `context.js`,
`sample-devices.js`, migration `0814_office_ios_sessions.sql`, tests `apps/api/test/office-ios-auth.test.js`.

## Server address

`Config/Dev.xcconfig` → `https://sunpride.cauldnclark.com`. For lane testing create gitignored
`Config/Local.xcconfig` with `SUNPRIDE_API_ORIGIN = http:/$()/127.0.0.1:4620`. HTTPS only, except plain
HTTP to this Mac.

## Build and test

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
bun run native:office-ios          # build + unit tests on an iPhone 17 simulator
bun run ipa:office-ios-beta        # signed "Sunpride Office (Beta)" .ipa (no upload)
```

- `project.yml` is the XcodeGen source; the generated `OfficeIOS.xcodeproj` is checked in. Targets:
  `OfficeIOS`, `OfficeIOSTests`, `OfficeIOSUITests`; schemes `OfficeIOS-Dev`, `OfficeIOS-Beta`.
- **Unit tests** (no network): formatting (pesos, Manila time, plain words), auth/session (URLProtocol
  stubs), Decide rules, and decoding of real responses captured from a lane API (`OfficeIOSTests/Fixtures`,
  tokens redacted).
- **UI tests** are live against a lane API (Local.xcconfig). The password comes only from the environment:
  `TEST_RUNNER_OFFICE_TEST_PASSWORD="$(cat ~/.sunpride-keys/v2-test-password)" xcodebuild test …`.
  They cover sign-in (and a wrong password), the five tabs sitting at the bottom on iPhone and iPad (and in
  iPad landscape), Decide approve, store detail with its map pin, and sign-out. The Decide test needs
  count reviews planned by `manager@` and a stock authority band that names the `approver` role (see
  `scripts/lane-seed-decide.js`). `OfficeScreenshotTour` (only with `TEST_RUNNER_OFFICE_SHOTS=1`) captures
  the report screenshots.
