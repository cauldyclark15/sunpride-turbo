# Inventory implementation reference — v2

## Scope and authority

This design reference is implemented through `apps/api/src/domains/inventory` and SQL in `packages/db`. The binding platform is [BACKEND_V2](BACKEND_V2.md); the client's SAP source-of-truth rules and [SAP backbone](../spec/sap.md) govern pricing, credit, inventory value and accounting posting. The ledger records physical execution and must not be confused with financial acceptance.

## Atomic stock writer

`postMovement` is the sole ordinary stock writer. A stock command commits its document, immutable movement and lines, exact lot allocation, signed ledger entries, derived product/location/lot summaries, command receipt and audit/change facts in one PostgreSQL transaction. A failure rolls back the command. Same-key/same-payload retry returns the stored result; changed content conflicts. Never call SAP or a printer inside this transaction.

## Quantity, identity and status

Use immutable UUIDs internally and scoped human codes for display. Quantities are exact integer base units with explicit UOM conversion; money is centavos. Never sum unrelated units or label scaled base quantities as cases. Distinguish warehouse/truck locations, stock status, reserved quantity and physical on-hand. Preserve lot, manufacturing/expiry dates, FEFO policy and frozen exact allocations on reversals.

## Controlled workflows

- Opening stock: validated import, no duplicate physical posting; corrections are counts/adjustments.
- Receipts: post only accepted facts to the authorized location.
- Transfers: staged custody transitions, with source/destination authorization and idempotent receipt.
- Counts: freeze balance version and movement markers; blind counters do not see expected quantities/variances reserved for independent approvers.
- Adjustments and quality: reasoned, separately approved where required; compensating movements preserve history.
- Van load/sale/return/damage/void/unload: the same ledger, not a second stock engine. Offline local projections remain provisional until server acceptance.
- Manufacturing/BOM and other unused workflows stay hidden where no current v2 workflow is enabled; this cleanup does not create them.

## SAP reconciliation and outage behavior

SAP replicas retain source key, version, effective interval and receive time. Snapshots are observations; never blindly overwrite newer physical execution. Reconciliation compares explicit cutoffs and complete source pages. Pending financial effects use stable keys and visible retries/review. A temporary SAP outage does not cause a second local movement or erase custody obligations.

## Reads, jobs and proof

Scoped `/api/v1/inventory` endpoints serve the web. `/ws` invalidates authorized query keys. Native projections use `/api/sync`. The API scheduler handles due expiry work through normal posting, not balance patches.

Run `SP_LANE=<lane> bun run test` in `apps/api` and inspect `test/inventory.test.js`, `test/imports.test.js`, `test/van.test.js` and integration tests. DB tests verify constraints and all baseline tables/indexes. These are source/SQL proofs, not a claim of production SAP, native printer or field-route acceptance.
