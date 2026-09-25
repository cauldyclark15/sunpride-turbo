# ADR-007: Inventory location and stock-status semantics

Status: accepted. This ADR pins behaviour that is already implemented in `packages/backend/convex/inventory/` so later modules extend it instead of reinterpreting it.

## Decision

- **A location is the only address for stock.** `inventoryLocations.type` is one of `warehouse`, `production`, `wip`, `truck`, `in_transit`, `returns`, or `virtual_boundary`. A rolling truck is a location, so truck custody needs no separate stock model — vehicle and trip stock posts through the same movement engine as a warehouse (`CVX-029`, `VAN-018`).
- **Stock status partitions quantity at a location.** Statuses are `available`, `quality_hold`, `quarantine`, `damaged`, `expired`, `rejected`, `wip`, and `in_transit`. Only `available` is sellable; availability is usable physical stock minus hard reservations.
- **Every quantity change is an immutable movement.** `inventoryMovements` plus lines, exact lot allocations, and ledger entries are written with the balance updates inside one Convex mutation by `postMovement`. Posted entries are never edited or deleted; corrections are compensating movements.
- **Balances are summaries derived from the ledger.** `inventoryBalances` (product × location) and `inventoryLotBalances` (product × lot × location × status) each carry a `version` and a `lastMovementId`. A balance is never written by anything except the posting engine.
- **Opening stock is explicit.** It is an `opening_balance` movement with `sourceType: "cutover"`, one stable idempotency key, and a source reference on every lot and movement. There are no implicit opening quantities, and demo fixtures use the same governed mutation (see `docs/runbooks/INVENTORY_OPERATIONS.md`).
- **Reversals invert the original allocations exactly.** They never re-run FEFO. If the original stock has moved or been consumed, the command enters review-required rather than inventing an impossible reversal.
- **FEFO is the default allocation policy**, with user-selected lots honoured exactly or failed — never silently substituted.
- **Negative availability is disabled** by product policy. Any future exception must be an explicit, scoped policy and every negative posting is flagged for reconciliation.
- **SAP snapshots are observations, never corrections.** `sapInventorySnapshots` records what ERP reported at a cutoff; it never overwrites an operational balance (ADR-003). Real differences become a stock count and a separately approved adjustment.

## Consequences

- New stock-changing features are rejected unless they post through `postMovement`; a parallel path to a balance is a defect.
- Physical count, transfer, production, and POS features all inherit idempotency, exact allocation, and ledger traceability by construction.
- Reconciliation answers "why do we differ from SAP" with evidence — movement, allocation, ledger before/after, balance version, audit, and integration effect — rather than by patching balances.
