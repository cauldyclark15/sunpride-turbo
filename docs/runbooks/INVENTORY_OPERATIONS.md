# Inventory operations runbook

## Provision a new environment

1. Bootstrap the configured super-admin profile and seed or synchronize product/customer/warehouse master data.
2. From Web → Inventory, run **Provision inventory foundation** once. The mutation is idempotent and creates UOMs, warehouse/truck/transit/WIP/production/returns/boundary locations and product policies. It deliberately creates no stock.
3. Export and approve the cutover quantity, lot, expiry, and unit-cost file. Post it through `inventory.setup.postOpeningBalances` with one stable cutover idempotency key and source reference.
4. Verify Web → Inventory → Movement ledger contains the approved opening movement and that every imported product-location balance has a nonzero version.
5. Replay the same opening request to prove it is reported as a duplicate and creates no additional stock.
6. Compare physical opening counts with SAP using a reconciliation cutoff before enabling receiving, production, transfer, or POS roles.

There are no implicit opening quantities. Demo/test fixtures call the same explicit opening-balance mutation with clearly labeled source references.

## Trace a stock discrepancy

1. Identify product, location, stock status, lot, and the timestamp at which the difference was observed.
2. Read the product-location summary and lot-location balance.
3. Follow `lastMovementId` into Inventory → Movement ledger and the `inventory.queries.trace` query.
4. Verify the command payload hash, movement lines, exact allocations, ledger before/after values and versions, business document, audit event, and outbound SAP effect.
5. Compare against the newest SAP snapshot at or before the agreed cutoff. Do not overwrite the Convex balance from the snapshot.
6. Classify the difference as mapping, timing, missing external event, physical count variance, or software integrity issue.
7. If physical stock genuinely differs, create a stock count and have another authorized user approve its adjustment.

## SAP outage or dead letter

- Physical operations may continue in Convex. Pending effects retain their stable event IDs.
- The connector retries with bounded exponential backoff. Never generate a new movement solely to retry SAP.
- Inspect connector SQLite queue stats, Convex connector heartbeat, `integrationEvents.attempts`, `nextAttemptAt`, and `lastError`.
- Correct configuration or SAP availability, then allow the same effect to replay.
- After acknowledgement, verify the SAP material document number on the integration event and run reconciliation.

## Rolling-truck device conflict

- A route is owned by one salesperson/device pair. Do not clear the device database while it has queued sales.
- A device sequence conflict means Convex has acknowledged a different sequence than the device expects. Stop new sales, preserve IndexedDB, inspect the route’s `lastAcknowledgedSequence`, and compare all queued client request IDs.
- Replay missing lower sequences first. Duplicate request IDs are safe only when their payload hash is identical.
- If a sale is cancelled, use the server-side void workflow. Never add stock directly; the reversal must invert the original lot allocations.

## Route close

1. Synchronize every queued sale and resolve conflicts.
2. Start a blind `route_close` stock count for the truck location.
3. Count every lot and status, then submit the session.
4. A different authorized user reviews and posts any adjustment.
5. Confirm the final truck balance, checkpoint/count evidence, route status, and SAP effects before releasing the truck to another device.

## Expiry and quality

The daily Convex cron moves released expired lots from available to expired through a normal status-change movement. If it fails, rerun the internal job with a bounded batch; do not patch lot balances directly. Quality release/reject actions also move stock between statuses and must retain the same lot identity.
