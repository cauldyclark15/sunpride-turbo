# ADR-010: Native field-sales apps on iOS and Android; separate Android van-sales POS

Status: accepted (2026-09-25, JC). Supersedes the iOS clause of ADR-004 ("iOS is deferred until a
business owner requires it"). Every other clause of ADR-004 stands.

## Context

ADR-004 cancelled the PWA and made field execution Android-first, leaving iOS unscoped. The SFA
platform blueprint (`docs/architecture/SFA_PLATFORM_BLUEPRINT.md`) and the implementation tracker
were both written for four products, one of them a native iOS field app. JC confirmed on 2026-09-25
that the four-product shape is the plan of record.

## Decision

Sunpride Turbo ships four user-facing products on one Convex backend:

| Product                                                  | Stack                    | Users                                                              | Job                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management web (`apps/web`)                              | Next.js                  | Sales heads, managers, supervisors, admin, finance, inventory, ops | Plan → assign → monitor → approve → analyze. Home of the Master Coverage Plan (MCP).                                                                                                            |
| Field sales iOS (`apps/field-ios`)                       | Swift / SwiftUI          | Sales specialists, KAS, booking, supervisors                       | Execute the MCP: today's visits, check-in, activities, orders, reports.                                                                                                                         |
| Field sales Android (`apps/field-android`)               | Kotlin / Jetpack Compose | Same as iOS                                                        | Feature-equivalent to iOS. Workflows identical; platform UX conventions may differ.                                                                                                             |
| Van sales / truck POS Android (`apps/van-sales-android`) | Kotlin / Jetpack Compose | Van salesmen, cashiers, truck crew                                 | Load → sell → collect → print receipt → decrement truck stock → reconcile cash and stock → close trip, with zero connectivity. Runs on handheld devices with an attached or integrated printer. |

- The van-sales app is **its own application**, not the field app with POS switched on: its
  consistency model (truck custody, cash, sequenced receipts) is different. It shares contracts,
  never screens or state, with the field apps.
- Both field apps are built together against one contract set. Neither platform may ship a
  workflow the other does not have without a recorded exception.
- Native apps are clients, never systems of record (ADR-003); they reach Convex only through the
  mobile gateway and the sync protocol (bootstrap, outbox, delta pull).

## Consequences

- `SFD-011` (canonical contracts) needs Swift **and** Kotlin consumers again; ADR-004's "no Swift
  consumer is required" consequence is void.
- The Field iOS workstream (`IOS-001`…`IOS-022`) is back in scope. `IOS-001` and `AND-001` were
  waiting on a "native platform ADR" — this is it.
- iOS distribution adds an Apple Developer account, signing identities and TestFlight/MDM to the
  release plan; these are owner actions and money decisions, raised when the iOS app reaches its
  first build.
- Scope of the field MVP roughly doubles on the client side. Sequencing (which platform pilots
  first) is a delivery decision, not an architecture one, and is tracked in the issue tracker.
- `docs/architecture/SYSTEM.md` and the root README still describe the PWA as the field app; they
  must be brought in line (tracked).
