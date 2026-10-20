# System architecture

## Current runtime

The management web and its installable office app use a Bun HTTP API backed by native PostgreSQL 17 plus pgvector. Android field and van clients keep encrypted SQLite/Room stores and durable ordered outboxes. iOS source is retained but paused. The frozen field browser pilot displays a retirement notice without deleting retained evidence.

- Web: same-origin `/api/v1`, `/api/auth`, `/api/me`, `/api/media` and authenticated `/ws` invalidation.
- Native: v2 bearer/device authentication and `POST /api/sync/pull` / `POST /api/sync/push`.
- Database: UUID primary keys, SQL constraints, transaction-owned audit, change log and durable receipts.
- Jobs: in-process schedules plus durable `jobs`; realtime fan-out uses PostgreSQL LISTEN/NOTIFY.
- SAP: one mediation domain in `apps/api/src/domains/integration`, currently against `apps/sap-mock`.

SAP remains the business system of record for pricing, credit, inventory value and financial posting. Local replicas retain provenance/version/effective dates. Offline transactions are provisional until sync and accounting acceptance. The local movement ledger records physical execution without claiming that a local receipt is a final SAP or BIR document.

## Invariants

Every business write rechecks current capability and stored scope. Domain changes, command receipts and required audit/change facts commit together. `postMovement` in `apps/api/src/domains/inventory/posting.js` is the sole ordinary writer of stock movements, exact allocations and balances. External calls are post-commit effects, not part of the stock transaction. Retry identical bytes with the original key; changed content under the same key conflicts.

Master data and approval snapshots are server-owned. Phones record facts and retain pending/review/held work; neither a reconnect nor an empty delta proves that all work was accepted. Scope changes and authorization withdrawal must not resurrect stale cached records. Raw location evidence is independent of certification and productive-call policy.

## Source map

| Area | Source |
| --- | --- |
| Platform/auth/devices/sync/media | `apps/api/src/core` |
| Domain business behavior | `apps/api/src/domains` |
| Database and seeds | `packages/db` |
| Web transport/auth | `apps/web/src/lib/api`, `apps/web/src/lib/auth` |
| Android products | `apps/field-android`, `apps/van-sales-android` |
| SAP contracts | `packages/integration-contracts/sap/v1` |

The binding [backend](BACKEND_V2.md) and [analytics](ANALYTICS_V2.md) contracts win over older design notes. For release operations use [release and cutover](../spec/release-and-cutover.md); the native database listens on 5432. Source presence is not proof of deployment, full-route offline acceptance, printing, or production SAP connectivity.
