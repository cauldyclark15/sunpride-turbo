# ADR-003: Operational movement ledger and SAP authority

Status: accepted, updated to the Phase 1 SAP source-of-truth boundary and v2 runtime.

SAP is the business system of record for pricing, credit, inventory value and financial posting. The Bun API and PostgreSQL movement ledger record operational execution, physical custody, approval and pending effects. A local accepted operation is not itself a final ERP or fiscal outcome.

A stock change exists only when `postMovement` atomically commits the business document, immutable movement/lines, exact lot allocations, signed ledger, derived balances, command receipt and audit/change facts. No competing balance writer or SAP network call is allowed inside that transaction. Corrections use reasoned counts, approved adjustments or compensating movements; posted facts are not silently overwritten.

IDs are UUIDs. Human codes and SAP keys are separate. Money is integer centavos and quantity is exact base units with explicit scale/UOM. Reversal uses original captured allocations, not a fresh FEFO choice. SAP snapshots retain provenance and cutoff completeness; they never blindly overwrite newer physical execution.

Durable posting effects retain the original idempotency key through uncertainty. A SAP outage leaves the operation pending/reviewable; it must not cause a second local movement. When the API is unavailable, office writes stop; an already authorized phone may record provisional work within its lease and conservative stock projection. Reconnection reauthorizes the device and stored scope before acceptance or replay.

Implementation: `apps/api/src/domains/inventory/posting.js`, `apps/api/src/domains/integration`, `packages/db`. See [inventory reference](../architecture/INVENTORY_SYSTEM_IMPLEMENTATION_PLAN.md) and [SAP boundary](ADR-018-SAP-TURBO-SOURCE-OF-TRUTH.md).
