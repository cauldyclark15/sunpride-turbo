# SFA delivery sequence

Status: plan of record (2026-09-25). The GitHub issues are grouped into these milestones; work runs top to bottom, one issue at a time, each group finished before the next starts. The only exception is group 00 (client inputs), which runs alongside everything.

Order inside a group is the order issues are taken. It was checked against every issue's recorded dependencies: nothing depends on an issue in a later group, except the known cases below.

Known exceptions (built ahead of their paperwork, closed when the paperwork lands):

- `SFD-005`, `SFD-013`, `SFD-014` — the CSV imports were built in the foundation slice before the formal contract/ledger decisions (`SFD-004`, `SFD-011`); those decisions document what exists.
- `SFD-004` names the truck-stock ledger (`CVX-029`, group 13) as a dependency; the ledger semantics are decided in group 02 and the truck part is implemented in group 13.

Phase labels (`phase:*`) keep the original tracker's phase for reference.

## 00 — Client inputs

Owned by jc and Sunpride; runs alongside every group. Answers turn provisional decisions final and unblock the memo features.

1. `SOP-013` Get Sunpride's answers to the memo's open questions
2. `ARCH-001` Collect Sunpride sales organization structure
3. `ARCH-002` Collect current Master Coverage Plan artifacts
4. `ARCH-003` Run BeatRoute workflow walkthrough with experienced Sunpride hire
5. `ARCH-004` Collect sales-force role catalog
6. `ARCH-005` Collect customer and outlet master samples
7. `ARCH-006` Collect product, UOM, pricing and promotion samples
8. `ARCH-007` Collect van-sales operational documents

## 01 — Land the groundwork

Commit the built-but-uncommitted foundation and close what it already delivers. Exit: the uncommitted foundation is merged green; issues it delivers are closed.

1. `DEV-001` Land the SFA foundation vertical slice (currently uncommitted)
2. `CVX-001` Review and preserve existing Convex authority boundaries
3. `WEB-001` Review existing Next.js management shell
4. `SAP-001` Audit existing Bun SAP connector
5. `SFD-003` Approve SFA-first product and UOM baseline
6. `SFD-005` Define four explicit CSV operation contracts
7. `SFD-006` Choose the non-SAP pricing baseline for SFA orders
8. `SFD-013` Implement product master CSV import with preview
9. `SFD-014` Implement opening-stock CSV import
10. `ARCH-024` Define PWA retirement and migration plan
11. `CVX-002` Split sales-force domain into bounded modules
12. `SFD-010` Publish dependency-ordered SFA vertical-slice gates

## 02 — Domain decisions

Write the remaining design decisions (provisional where client input is pending). Exit: each decision is an ADR or a doc section in `docs/`. Where client input is missing the decision is written as provisional and flagged.

1. `ARCH-008` Define Sunpride sales terminology dictionary
2. `ARCH-009` Define configurable organization hierarchy model
3. `ARCH-010` Define customer versus outlet boundary
4. `ARCH-011` Define territory, route and beat model
5. `ARCH-012` Define Master Coverage Plan lifecycle
6. `ARCH-013` Define visit state machine
7. `ARCH-014` Define visit intent catalog
8. `ARCH-015` Define visit exception and reason codes
9. `ARCH-016` Define geofence and GPS evidence policy
10. `ARCH-017` Define offline business guarantees
11. `ARCH-018` Define company-device registration and revocation policy
12. `ARCH-019` Define RBAC and organizational scope matrix
13. `ARCH-020` Define SAP/Turbo source-of-truth matrix
14. `ARCH-021` Document SAP interface inventory
15. `ARCH-022` Inventory target Android POS hardware
16. `ARCH-023` Define non-functional requirements
17. `ANA-001` Approve sales-execution KPI definitions
18. `SFD-001` Approve canonical SFA identifiers and ownership map
19. `SFD-004` Approve inventory ledger and location semantics
20. `ARCH-025` Create SFA architecture ADR set
21. `DOC-001` Align README and system architecture with ADR-004 and ADR-010

## 03 — Organization, people and access

Org units, employees, teams, server-side scope, audit, remaining stock imports. Exit: an admin can create org units, people, teams and grant scoped access; every new endpoint checks scope server-side.

1. `CVX-003` Add organization-unit schema and indexes
2. `CVX-004` Add sales employee/team assignment schema
3. `CVX-023` Enforce permission and organizational scope server-side
4. `SFD-002` Approve organization, team, role and data-scope contract
5. `SOP-001` Seed client positions and effective-dated call/work-with standards
6. `CVX-024` Standardize audit metadata
7. `WEB-002` Organization hierarchy administration
8. `WEB-003` Sales employee and team administration
9. `SFD-012` Complete organization, team and role foundation slice
10. `SFD-015` Implement stock addition and adjustment CSV import
11. `SFD-016` Implement cycle-count reconciliation CSV workflow
12. `SFD-017` Build shared web import and reconciliation workspace

## 04 — Territories, routes and outlets

Where people sell: territories, routes/beats, outlet profiles and locations. Exit: outlets sit on routes inside territories, with verified locations.

1. `CVX-005` Add territory schema
2. `CVX-006` Add route/beat schema
3. `CVX-007` Add outlet operational schema
4. `WEB-004` Territory administration
5. `WEB-005` Route / beat administration
6. `WEB-006` Outlet operational profile
7. `WEB-007` Outlet geolocation verification workflow
8. `WEB-008` Assign outlets to territory and route

## 05 — Coverage plan core

Monthly MCP: build, assign, approve, generate planned visits — the memo's plan-and-approve loop. Exit: a salesperson's monthly MCP can be prepared, approved and turned into planned visits. **First feature milestone to demo to Sunpride.**

1. `CVX-008` Add coverage-plan schema
2. `CVX-009` Add coverage-plan outlet schema
3. `CVX-010` Add coverage assignment schema
4. `CVX-011` Add planned-visit schema and generation indexes
5. `WEB-009` Create and version Master Coverage Plans
6. `WEB-010` MCP spreadsheet-style planning grid
7. `WEB-011` Configure visit frequency and preferred day
8. `WEB-012` Assign salesperson to coverage plan
9. `WEB-013` MCP approval workflow
10. `SOP-003` Monthly MCP prepare → approve loop, versioned per person per month
11. `SOP-006` Weekly routine templates per position feeding the MCP
12. `WEB-018` Generate planned visits from active MCP
13. `WEB-025` MCP and assignment audit history

## 06 — Coverage plan views and tools

Calendar, route, map and employee views; exceptions; MCP import/export. Exit: planners can see and adjust MCPs in every view they asked for, and import their existing sheets.

1. `WEB-014` MCP calendar view
2. `WEB-015` MCP territory and route view
3. `WEB-016` MCP map view
4. `WEB-017` MCP employee view
5. `WEB-019` Coverage-plan exception management
6. `WEB-020` Import existing MCP / route sheets
7. `WEB-021` Export MCP and route schedules

## 07 — Visit backend and mobile sync

Visit/activity/evidence data, device registration, bootstrap, push/pull sync, idempotency, contracts. Exit: the backend can serve a phone its day and accept its offline work exactly once.

1. `CVX-012` Add visit execution schema
2. `CVX-013` Add visit activity schema
3. `CVX-014` Add location evidence schema
4. `CVX-015` Add field task schema
5. `CVX-016` Add collections schema
6. `CVX-026` Implement field evidence file metadata
7. `CVX-025` Create immutable execution event stream
8. `QSR-011` Verify audit trail completeness
9. `SFD-009` Approve shared audit and execution-event contract
10. `CVX-018` Add registered-device schema
11. `CVX-019` Implement mobile bootstrap endpoint
12. `CVX-020` Implement cursor-based mobile delta pull
13. `CVX-021` Implement batched mobile push endpoint
14. `SFD-007` Version shared web, mobile and backend SFA contracts
15. `SFD-011` Implement canonical contract artifacts and compatibility checks
16. `CVX-022` Implement processed idempotency-key registry

## 08 — Native field apps foundation

iOS and Android built side by side: project, sign-in, device, local DB, sync, diagnostics, distribution. iOS and Android are built together, one issue pair at a time. Exit: both apps sign in, register the device, sync and survive going offline.

1. `IOS-001` Create native SwiftUI field-sales application
2. `AND-001` Create native Kotlin/Compose field-sales application
3. `IOS-002` Implement Sunpride iOS design tokens
4. `AND-002` Implement Sunpride Android design tokens
5. `IOS-003` Implement iOS authentication and secure token storage
6. `AND-003` Implement Android authentication and Keystore-backed token storage
7. `IOS-004` Implement iOS device registration
8. `AND-004` Implement Android device registration
9. `IOS-005` Create iOS local SQLite database
10. `AND-005` Create Room local database
11. `IOS-006` Implement iOS bootstrap synchronization
12. `AND-006` Implement Android bootstrap synchronization
13. `IOS-007` Implement iOS outbox and idempotent push
14. `AND-007` Implement Android outbox and idempotent push
15. `IOS-008` Implement iOS delta pull and conflict handling
16. `AND-008` Implement Android delta pull and conflict handling
17. `IOS-019` Implement persistent sync/offline indicator
18. `AND-019` Implement persistent sync/offline indicator
19. `IOS-021` Implement background sync using BackgroundTasks
20. `AND-021` Implement WorkManager background synchronization
21. `IOS-022` Add iOS structured logging and crash diagnostics
22. `AND-022` Add Android structured logging and crash diagnostics
23. `QSR-021` Define iOS enterprise distribution approach
24. `QSR-022` Define Android managed distribution approach
25. `SFD-008` Approve offline authority and conflict matrix
26. `SFD-018` Expose scoped product and inventory revisions through mobile sync

## 09 — Field sales day on iOS and Android

Today, route, outlet, GPS check-in, activities, call sheet, orders, photos, check-out, productive-call rule. Exit: a salesperson can run a full day on either phone, offline, and the call is scored productive or not by the client's rule.

1. `IOS-009` Build Today dashboard
2. `AND-009` Build Today dashboard
3. `IOS-010` Build daily route screen
4. `AND-010` Build daily route screen
5. `IOS-011` Build scoped customer search and outlet detail
6. `AND-011` Build scoped customer search and outlet detail
7. `IOS-012` Implement GPS-validated check-in
8. `AND-012` Implement fused-location GPS check-in
9. `IOS-013` Implement visit intents and structured activities
10. `AND-013` Implement visit intents and structured activities
11. `SOP-008` Call Sheet (Annex C) per account in the field apps
12. `IOS-014` Implement offline field order capture
13. `AND-014` Implement offline field order capture
14. `IOS-015` Implement field order review and submission
15. `AND-015` Implement order review and submission
16. `IOS-016` Implement visit photo capture and queued upload
17. `AND-016` Implement CameraX visit photo evidence
18. `IOS-017` Implement check-out and visit completion
19. `AND-017` Implement check-out and visit completion
20. `SOP-002` Encode the client's productive-call rule per channel
21. `IOS-018` Open native turn-by-turn navigation
22. `AND-018` Open native map navigation

## 10 — Supervision and the memo's reports

Targets, supervisor screens, Work-With coaching, talk sheet, trainer forms, DAR/ROAR, DSR, per diem. Exit: supervisors see execution live and the memo's coaching and report forms come out of the system instead of paper and chat.

1. `CVX-017` Add sales-target schema
2. `WEB-022` Supervisor team execution screen
3. `WEB-023` Visit exception review queue
4. `WEB-024` Field activity map
5. `IOS-020` Enable supervisor role in iOS app
6. `AND-020` Enable supervisor role in Android app
7. `SOP-005` Work-With coaching sessions with cadence minimums
8. `SOP-011` Talk Sheet (Annex E) with carry-over rule
9. `SOP-010` Trainer forms: training program, training sheet, job evaluation
10. `SOP-009` Daily Activity Report and Route Activity Report
11. `SOP-007` Daily Sales Report (Annex B) generated from field data
12. `SOP-004` Per-diem validation against the approved MCP

## 11 — SAP masters and orders

Product/UOM/customer/price/promo/credit sync from SAP; field orders posted to SAP with retry and reconciliation. Exit: master data flows in from SAP and field orders post to SAP with retry and reconciliation.

1. `SAP-002` Synchronize product master from SAP
2. `SAP-003` Synchronize UOM and barcode data from SAP
3. `SAP-004` Synchronize customer accounting master from SAP
4. `SAP-005` Synchronize price lists
5. `SAP-006` Synchronize promotion rules required offline
6. `SAP-007` Synchronize credit/payment-term summary
7. `SAP-008` Queue approved field orders for SAP posting
8. `SAP-009` Capture SAP order document references and status
9. `SAP-010` Implement integration retry/backoff policy
10. `SAP-011` Implement integration dead-letter / exception queue
11. `SAP-012` Create Turbo-to-SAP order reconciliation report

## 12 — Field sales pilot (Cebu)

Hardening, security and UAT, guides, then the controlled Cebu field pilot. Exit: field-sales UAT passed and the Cebu field pilot run.

1. `CVX-035` Add Convex domain and sync test suite
2. `QSR-004` Verify duplicate-prevention invariants
3. `QSR-006` Perform role/scope authorization matrix testing
4. `QSR-007` Verify device revocation and lost-device behavior
5. `QSR-005` Test GPS/geofence edge cases
6. `QSR-003` Run offline/poor-network chaos tests
7. `QSR-013` Test mobile bootstrap size and duration
8. `SFD-019` Add shared foundation contract and end-to-end tests
9. `QSR-009` Implement abuse/rate controls for mobile endpoints
10. `QSR-010` Review local mobile data protection
11. `QSR-008` Audit secrets and client configuration
12. `QSR-001` Create end-to-end SFA UAT scenarios
13. `QSR-016` Create field-sales user guide
14. `QSR-017` Create supervisor/admin user guide
15. `QSR-019` Run controlled Cebu field-sales pilot

## 13 — Van sales foundation

Vehicles, trips, truck stock ledger; the separate Android POS app with its DB, sync, trip start and loading. Exit: a truck can be assigned, loaded and tracked on the handheld.

1. `CVX-027` Add vehicle and van-trip schema
2. `CVX-028` Add van trip-load schema
3. `CVX-029` Implement truck-stock ledger integration
4. `VAN-001` Create dedicated native van-sales Android application
5. `VAN-002` Create van-sales Room database
6. `VAN-003` Implement van-sales bootstrap and sync engine
7. `VAN-013` Generate offline-safe transaction identifiers
8. `VAN-004` Start assigned van trip
9. `VAN-005` Confirm truck loading
10. `VAN-006` Maintain offline truck stock ledger
11. `VAN-007` Select planned or walk-in customer

## 14 — Van selling and printing

Product search, scanning, offline pricing, checkout, stock deduction, payments, printers, returns, voids. Exit: a full sale — search, scan, price, pay, print, deduct stock — works with no signal.

1. `VAN-008` Build fast POS product search
2. `VAN-009` Support camera and hardware barcode scanning
3. `VAN-010` Apply customer price list and promotion rules offline
4. `VAN-011` Implement van-sales checkout
5. `VAN-018` Deduct truck stock atomically on sale
6. `VAN-012` Record approved payment methods
7. `VAN-014` Create printer abstraction layer
8. `VAN-015` Implement generic ESC/POS Bluetooth adapter
9. `VAN-016` Implement embedded printer adapter
10. `VAN-017` Receipt reprint and printer diagnostics
11. `VAN-019` Record customer product returns
12. `VAN-020` Record damage/spoilage
13. `VAN-021` Implement void/cancel workflow

## 15 — Van trip close and SAP

Cash and stock reconciliation, trip close, sync health, van sales/returns/loads to SAP. Exit: a trip closes with cash and stock reconciled and the results reach SAP.

1. `VAN-022` Perform end-of-trip cash reconciliation
2. `VAN-023` Perform end-of-trip stock reconciliation
3. `VAN-024` Close van trip
4. `VAN-025` Show van sync and posting health
5. `SAP-013` Define and implement van-sale SAP posting
6. `SAP-014` Post approved van/customer returns to SAP
7. `SAP-015` Reconcile truck load/stock movements with SAP

## 16 — Van sales pilot (Cebu)

Van UAT, operating guide, controlled Cebu van pilot. Exit: van-sales UAT passed and the Cebu van pilot run.

1. `QSR-002` Create van-sales UAT scenarios
2. `QSR-018` Create van-sales operating guide
3. `QSR-020` Run controlled Cebu van-sales pilot

## 17 — Analytics and suggested orders

Rollups, dashboards, the memo's admin report pack, merchandising audits, suggested order v1. Exit: management dashboards and the memo's admin report pack run on real data.

1. `CVX-031` Implement daily agent metric rollups
2. `CVX-032` Implement territory/customer/SKU rollups
3. `CVX-030` Add merchandising audit schemas
4. `ANA-002` Build daily execution dashboard
5. `ANA-003` Build supervisor productivity dashboard
6. `ANA-004` Build territory performance dashboard
7. `ANA-005` Build customer execution dashboard
8. `ANA-006` Build SKU distribution dashboard
9. `ANA-007` Build management exception dashboard
10. `ANA-008` Build route/coverage compliance analytics
11. `SOP-012` Admin report pack required by the memo
12. `ANA-009` Implement deterministic suggested-order engine v1
13. `ANA-010` Expose suggested order in field apps

## 18 — Go-live and national rollout

Scale, monitoring, runbooks, PWA retirement, go-live checklist, national waves. Exit: go-live checklist signed, PWA retired, national rollout in waves.

1. `CVX-033` Add pagination/index review for nationwide scale
2. `CVX-034` Add scheduled cleanup and planning crons
3. `QSR-012` Load-test nationwide activity patterns
4. `QSR-014` Implement operational monitoring
5. `SAP-016` Version SFA/van SAP integration contracts
6. `SAP-017` Build integration health monitoring
7. `QSR-015` Create support runbooks
8. `QSR-023` Freeze and retire field PWA
9. `QSR-024` Create go-live checklist and rollback plan
10. `QSR-025` National rollout by controlled waves

## 19 — AI assistance

AI permissions, copilots for sales/supervisors/management, evaluation and logging. After rollout, once analytics are stable.

1. `ANA-011` Define AI tool permissions and data scopes
2. `ANA-012` Build salesperson daily-priority copilot
3. `ANA-013` Build supervisor attention copilot
4. `ANA-014` Build management natural-language analytics
5. `ANA-015` Create AI evaluation suite
6. `ANA-016` Log AI tool usage and decision traces safely

## 20 — Future backlog

Not scheduled; revisit after go-live. Not scheduled.

1. `FUT-001` Automatic route optimization
2. `FUT-002` Optional continuous active-duty route telemetry
3. `FUT-003` Computer-vision merchandising validation
4. `FUT-004` Demand forecasting by outlet/SKU
5. `FUT-005` ML-enhanced suggested order
6. `FUT-006` Dynamic MCP recommendations
7. `FUT-007` Customer churn / inactivity signals
8. `FUT-008` Voice notes with structured transcription
9. `FUT-009` Offline map tiles
10. `FUT-010` Salesforce gamification
11. `FUT-011` Commission/incentive calculation
12. `FUT-012` Configurable field workflow builder
13. `FUT-013` Central mobile device management integration
14. `FUT-014` Customer self-service portal
15. `FUT-015` Enterprise BI/warehouse export
