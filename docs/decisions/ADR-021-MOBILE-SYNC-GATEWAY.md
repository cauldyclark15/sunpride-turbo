# ADR-021: Versioned mobile sync gateway over Convex HTTP actions

Status: accepted (2026-09-25, JC lead) — provisional items marked inline

## Context

ARCH-025 requires a mobile gateway decision. ADR-010 routes native iOS/Android field apps and the separate Android van POS through a mobile gateway, but does not choose its transport. ADR-019 defines durable outbox, bootstrap, cursor and per-operation outcomes; ADR-020 requires device-bound authentication on every sync. The blueprint §§30–38 proposes a mobile sync boundary and `packages/backend/convex/mobile/` with explicit bootstrap, pull and push, but does not choose HTTP actions versus a client SDK. Its examples resemble Convex function calls, not a prescribed transport.

The proposed justification that Swift/Kotlin have no first-party reactive Convex client is **incorrect**: Convex documents [Swift](https://docs.convex.dev/client/swift/overview) and [Android/Kotlin](https://docs.convex.dev/client/android/overview) clients with reactive subscriptions. This decision chooses an explicit durable sync protocol for offline control, not because native clients are unavailable.

## Decision

Native apps call a **versioned Convex HTTP-action API** (`/mobile/v1/bootstrap`, `/mobile/v1/pull`, `/mobile/v1/push`) over HTTPS, rather than using the Convex JS client or subscribing to domain queries as their authoritative mobile data feed. Swift/Kotlin use native HTTP transport and generated/shared versioned request and response schemas; UI reads its encrypted local database. Keep gateway handlers in `packages/backend/convex/mobile/`; HTTP actions authenticate, validate and invoke internal queries/mutations for scoped reads and atomic business writes, never duplicate inventory or order authority in an action.

- **Bootstrap:** after online enrollment/login, return a bounded, scoped snapshot, contract version, server time, cache/lease limits and opaque starting cursor; do not expose nationwide data.
- **Delta pull:** authenticate and recheck device, user, role, scope and route (ADR-020); page changes and tombstones with an opaque cursor bound to identity, scope and protocol version. Invalid or expired cursors require a safe rebootstrap, not a silent partial refresh.
- **Idempotent push:** send stable client-UUID operations (`clientRequestId` per ADR-002/ADR-012/ADR-019), with route, device and monotonic POS sequence where applicable. Deduplicate by device/operation ID and payload hash; changed payload with the same ID conflicts. Return per-operation accepted/rejected/conflict results and server acknowledgments. Convex mutations own validation, lifecycle, pricing and inventory posting; a network retry cannot post twice.
- Authenticate each request with a short-lived device-bound credential and proof of possession; verify binding and revocation server-side before any read/write (ADR-020). Do not trust client-supplied employee or scope; reject unsupported versions explicitly.

## Consequences

- This adds a stable, independently testable contract and mobile gateway implementation; no such complete gateway is claimed to exist today (ADR-019). Native SDKs may still be used for separately approved online-only features, but not as a substitute for the durable outbox/cursor protocol.
- Test duplicate/reordered pushes, pagination and tombstones, expired cursors, revoked devices, scope changes, offline reboot, and backwards-compatible contract upgrades before a pilot. The blueprint's gateway domain and explicit sync are preserved; this ADR specifies its HTTP-action transport.

## Open questions

- **Provisional — pending implementation/security review:** credential proof format, cursor retention/window and rebootstrap limits, maximum batch/page sizes, and contract compatibility window. Validate Convex HTTP-action limits and authentication integration with Better Auth during implementation.
