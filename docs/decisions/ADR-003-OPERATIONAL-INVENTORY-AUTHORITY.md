# ADR-003: Convex operational inventory authority

Status: accepted.

## Decision

Convex is the operational source of truth for physical inventory needed by Sunpride Web, manufacturing, distribution, and rolling-truck POS. SAP remains authoritative for approved ERP master data, accounting and financial inventory outcomes, closed-period policy, and SAP document identifiers.

An operational stock change exists only when one idempotent Convex mutation commits its business document, immutable movement, exact lot allocations, ledger entries, product-location and lot-location summaries, command result, audit record, and outbound integration effect. A network call is never made inside that mutation.

SAP snapshots are observations used for reconciliation. Once a product-location has an operational Convex balance, an incoming snapshot must never overwrite it. A real correction requires a separately reviewed adjustment.

## Identifier and contract ownership

- SAP assigns approved external product, supplier, customer, plant, financial document, and accounting identifiers.
- Convex assigns inventory command, movement, lot, reservation, receipt, transfer, count, adjustment, production, route-session, and POS order identifiers.
- Every external event uses a stable event ID, schema version, source sequence or document version, payload hash, idempotency key, correlation ID, and causation ID when applicable.
- The connector sends the Convex event ID to SAP as the external effect key. Retries must be idempotent in SAP.

## Quantity, lot, and availability policy

- Quantities are persisted as scaled `int64` base units; the initial scale is 1,000 per displayed case.
- Manufactured and seeded saleable products use lot tracking with FEFO allocation.
- Available-to-promise is physical available stock minus hard reservations. Quality hold, quarantine, rejected, damaged, expired, and in-transit stock are not sellable.
- Negative stock is disabled. One active device owns one rolling-truck route unless stock is explicitly partitioned.
- Reversals reference and invert the original allocations. They do not recalculate FEFO.

## SAP outage and recovery

A physically valid Convex posting remains valid while SAP is unavailable. Its integration effect stays pending with bounded exponential retry and eventually moves to visible dead-letter review. Recovery replays the same effect key; it never reposts inventory locally.

If Convex is unavailable, Web stock operations stop. An already opened truck route may continue within its cached conservative stock projection and ordered device sequence; queued sales synchronize when Convex returns.

## Backdating and closed periods

Offline POS preserves the device creation time as the movement effective time and the server commit time as posting time. Financial posting dates and closed-period treatment are determined by SAP. Privileged historical adjustments must use a reason and audit trail; the initial UI does not expose arbitrary backdating.

## Reconciliation and cutover

The inventory operations owner runs reconciliation against an explicit SAP cutoff. Differences are classified and reviewed; snapshots never auto-correct stock. Cutover provisions UOMs, locations, policies, lots, and idempotent opening movements, then verifies physical counts and SAP totals before accepting live transactions.

This ADR supersedes the stock-authority sentence in `docs/architecture/SYSTEM.md` and the generic order-only sync boundary in ADR-002 for rolling-truck POS.
