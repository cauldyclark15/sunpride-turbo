# Sunpride Van Sales (truck POS) — Android

Separate native app for truck sellers (PMOT, PMOT Extruck, RDS) per ADR-010 and ADR-004: Kotlin + Jetpack Compose, Android only, built for the Senraise H10P handheld (Android 14, 720×1440, built-in 58 mm printer and scanner, 3-button navigation bar). It shares wire contracts with the backend (`packages/domain-contracts/schemas/van-v1.schema.json`), never screens or state with the field apps.

| Doc                                              | What it covers                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [SETUP.md](SETUP.md)                             | Build, endpoints, practice (stub) mode, handheld test runner, screenshots                          |
| [ARCHITECTURE.md](ARCHITECTURE.md)               | Packages, `VanRepository` API, encrypted Room DB, truck-stock ledger, transaction ids, sync engine |
| [PRINTER_AND_SCANNER.md](PRINTER_AND_SCANNER.md) | Recovered Senraise printer AIDL, printer abstraction, scanner modes, camera fallback               |
| [SCREENS.md](SCREENS.md)                         | Screens and screenshot verdicts                                                                    |
| [beta.md](beta.md)                               | Beta APK: hidden features, signing key, `bun run apk:van-beta`, logo/splash, install and proof     |

Root check: `bun run native:van` (assemble, JVM tests and lint, then device tests on the H10P through the lock-guarded runner; skips the device step when the handheld is absent).

## Backend it talks to

`packages/backend/convex/van/`: vehicles, trips and load sheets (office, `van.manage`), discrepancy approval (`van.load.approve`, never the confirmer), and the signed device gateway `/van/v1/bootstrap` + `/van/v1/push` for `VAN_ANDROID` devices (`van.operate`). Every truck-stock change is an inventory movement through `inventory/posting.ts#postMovement`: `van_load` (depot → truck), `status_change` (damage on the truck), `van_unload` (leftovers back to the depot). Starting a trip opens the POS route session the existing sale path (`inventory/pos.ts#postSale`) needs.

## Defaults waiting on Sunpride (easy to change)

From `_handoffs/sunpride-van-sales-questions.md`, "What we plan today":

- One trip a day per truck, no top-ups — `VAN_POLICY.maxOpenTripsPerVehicleDay` (`convex/van/model.ts`).
- Warehouse loads, salesman confirms each line; a difference waits for a supervisor — `VAN_POLICY.loadDiscrepancyRequiresApproval`.
- One salesman, one device; crew names are optional text.
- Walk-in customers allowed, marked as walk-in with a reason (`policy.walkInAllowed`).
- Negative truck stock off by default; turned on per truck location by the existing negative-stock allowance (client said distributors may go negative) — sent to the device as `policy.allowNegativeStock`.
- Thermal receipt is a delivery receipt, not a BIR official receipt; reprints are marked REPRINT; amounts print with `P` until the peso glyph is confirmed on paper.

## What is stubbed or not built yet

- **Returns, voids, end-of-day cash/stock count**: tables exist in the encrypted DB (VAN-002); screens and sync operations are the next lane. Sales (VAN-011/012) are saved on the phone but not yet uploaded; the beta build shows them too ([beta.md](beta.md)).
- **Prices**: no price lists from Sunpride yet; `price_list_line` is empty and totals stay "Priced by the office".
- **Live backend**: the van functions are not deployed to the shared DEV deployment (the lead deploys after merge). Device tests and screenshots use the DEBUG-only practice backend (`VAN_STUB_BACKEND`) serving `fixtures/van-v1`; no live sign-in → bootstrap → push run has been made.
- **Office screens**: no web UI for vehicles/trips/load sheets/approval; use the Convex functions `van/vehicles:create`, `van/trips:plan`, `van/loads:plan`, `van/loads:approve`, `van/trips:returnLeftover`, `van/trips:close`.
- **Bluetooth ESC/POS printer** (VAN-015) and paper-out status: not built; non-Senraise devices report "No printer".
- **Physical scanner trigger and peso glyph**: broadcast delivery is tested on the device; an optical scan and the printed `₱` were not visually confirmed.
- **SAP**: no posting of van transactions.
