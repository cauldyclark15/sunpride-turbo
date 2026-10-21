# Inventory v2 authority

This lane answers: “Is the right stock in the right place?” SAP and manufacturing behavior are deliberately absent. No catalog, organization, order or analytics tables are written directly.

## Posting seam

`postMovement(tx, input)` in `posting.js` accepts the binding wave-3 shape:

```js
{
  kind, sourceType, sourceId, idempotencyKey, occurredAt,
  actor: { profileId, userId }, organizationId,
  lines: [{ productId, fromLocationId, toLocationId, quantityBase, uom, lotId?, stockStatus? }],
  note?
}
// -> { movementId, duplicate }
```

Pass an OPEN Bun SQL transaction, not a pool. The calling domain authorizes its command (inventory, van, imports, etc.). Posting refreshes the actor and verifies every persisted location scope BEFORE replay. A null actor is accepted only for internal `expiry_job` calls. A transaction-scoped advisory lock per organization serializes the inventory authority, including count snapshots; sorted per-product locks can replace it later if throughput warrants it.

The one writer inserts movement, movement lines, exact lot allocations, ledger, balance projections, command, audit through `org/audit.writeAudit`, pending `integration_events` outbox and scoped `recordChange` entries in that same transaction. It never consumes the integration outbox. Failures roll all of these back. Server-owned SHA-256 over canonical content binds the key to the actor and the request. Concurrent identical calls return one movement. Replays never publish another stock effect.

Optional additive line fields used by inventory commands are `fromStockStatus`, `toStockStatus`, `unitCostMinor` and `reservedDeltaBase`. A reserve/release movement changes reserved quantity but not physical quantity; reservation consumption uses `reservedDeltaBase = -quantityBase`. These fields do not change the required cross-lane signature. A source issue automatically selects eligible lots by FIFO/FEFO, or requires a lot under explicit-only policy. Lot/serial negatives are never permitted; serial behavior is not enabled in this beta.

Negative stock defaults to refusal, regardless of legacy product `allow_negative_stock`. Only an active distributor location allowance naming the movement type permits an untracked, unreserved available-stock issue below zero. Each negative posting records a reconciliation flag. Limit checks include both physical and available stock. Only another authorized person can settle a flag, after the shortfall is covered.

## Quantities and valuation

Read quantities are `{base, cases, pieces, display, valueCentavos}`. Cases are whole cases and pieces are the remainder. A 48-piece catalog case converts 1,920 pieces to `40 cs`; 150 pieces becomes `3 cs 6 pc`. Inputs are converted with the same effective catalog graph and product quantity scale, never a hardcoded 1,000. Product-specific edges override global edges. Conflicting/ambiguous conversions fail closed; a missing conversion is setup-needed, not an invented case size.

There is no product standard-cost column in the frozen catalog schema. Management reads therefore choose the default governed price via `orders/pricing.resolvePrice(db, {organizationId, productId, uom: baseCode, channelKey:null, customerCode:null, at})`. They show SELLING VALUE, not cost or margin. The legacy `products.unit_price` zero is never a fallback. No available price returns `valueCentavos:null` (unknown); genuine zero stock is worth zero. Server valuations use integer-centavo, integer-scale arithmetic with symmetric half-up rounding. Summaries become unknown if any contributing stocked row has unknown value; they never sum a misleading partial value. Booked receipt costs and the existing weighted-average/value ledger remain separate from management selling-value reads.

Days of cover = max(available base, 0) / (last 28 elapsed days of `inventory_issue` and `pos_sale` outgoing base / 28). Transfers/reservations are not consumption. No issues means unknown cover, not infinite cover. Prior stock is current physical less net ledger change over the same 28-day window. The 14-day end-of-Manila-day stock-value trend is reconstructed at TODAY'S default prices, not claimed as historical-cost valuation. Replenishment thresholds are our configurable operational target, not sales targets.

## HTTP contract

Prefix: `/api/v1/inventory`. Cookie or platform bearer authentication and the platform error envelope apply. IDs are lowercase UUID strings; command quantities are safe integer base units; money/cost fields are safe integer centavos. All POST bodies require `idempotencyKey` (1–200 characters). Document-only actions also have transactional `inventory_action_receipts` so uncertain retries return the original IDs. Successful commands publish topic `inventory` and call `enqueueRefresh(ctx, {kind:'stock', date:<Manila today>, unitId:<actor unit or null>})` after commit.

GET endpoints:

- `overview?locationId?` → `{asOf, period, valuation, nearExpiryDays:30, summary, locations, rows, out, low, nearExpiry, trend}`. Rows include product/location labels, physical/available/reserved/hold/bad-order quantities, selling value, prior quantity, issues/prior issues, target/reorder/suggested quantities, cover, status and catalog units. Every active product/location pair is represented, including never-stocked zero rows. Above 20,000 pairs the endpoint refuses and asks for a location filter rather than truncating a total.
- `products` → `[{id,code,name,tracking,units}]`; `locations` → `[{id,_id,code,name,type,orgUnitId,active}]` (`_id` is a compatibility alias for the existing panel prop only).
- `product?productId&locationId?` → `{product,stock,nearExpiry,movements}`.
- `receipts`, `transfers`, `counts`, `adjustments`, `reservations` → `{items:[{id,number,status,locations,canApprove,requestedBy}],nextCursor}`.
- `counts/detail?sessionId` → `{session,canApprove,lines:[{id,productId,code,name,lotNumber,stockStatus,counted,expected?,variance?}]}`. A blind counter NEVER receives expected or variance, including after posting. Only a distinct count approver sees those fields. Snapshot versions/movement markers remain server-only.
- `movements?productId?` → `{items:[{id,number,kind,status,at,lines}],nextCursor}`.
- `trace?movementId` → `{movement,allocations:[{id,lotNumber,quantity}],ledger:[{id,productId,locationId,status,delta,reservedDelta,before,after,balanceVersion}]}`. All source/destination locations must be in scope. A counter's own count-adjustment trace is hidden.
- `lots?productId?&lotId?` → scoped lot/location/status facts with valued on-hand/reserved/available quantities and expiry.
- `policies` → inventory product-policy settings, no catalog write authority.
- `replenishment?locationId?` → valued suggestions for low/out rows.
- `negative?cursor?&limit?&status?&locationIds?` → `{canManage,allowances,flags:{items,nextCursor}}` with valued flags and server-derived settlement permission. `status` is `open` (default) or `resolved`; `locationIds` is a comma-separated list of at most 200 UUIDs narrowing ONLY allowance lookups. Flag paging retains the caller's full authorized scope.

Paged routes accept `limit` (1–100, default 25) and a non-negative opaque-to-the-web numeric `cursor`. Scope filtering precedes slicing. Overview returns complete rows within its explicit bound. Older-document lists currently materialize scoped results before slicing; database-side keyset paging is an optimization, not an already implemented claim.

POST actions (after the prefix):

- `locations/save`: `{id?,orgUnitId,siteCode?,code,name,type,parentLocationId?,active?,allowsPicking?,allowsReceiving?,allowsSale?}`. National admin gate plus old/new unit scope; stock must be cleared before retirement, type change or ownership transfer. Cycles are refused.
- `opening/post`: `{sourceReference,lines:[{locationId,productId,quantityBase,lotNumber?,expiresAt?,manufacturedAt?,unitCostMinor?}]}`. National-only, refuses existing stock across statuses, posts `opening_balance/cutover` through the writer.
- `receipts/post`: `{receivingLocationId,receiptType?,deliveryReference?,note?,lines:[{productId,quantityBase,rejectedBase?,lotNumber?,expiresAt?,manufacturedAt?,unitCostMinor?}]}` → `{id,movementId,duplicate}`. Accept/reject partitions and quality-release policy are honored. Existing lot dates cannot be silently rewritten.
- `receipts/reverse`: `{receiptId,reason}` → `{id,movementId,duplicate}`; exact frozen lots, original document retained/cancelled.
- `transfers/request`: `{sourceLocationId,destinationLocationId,inTransitLocationId,lines:[{productId,quantityBase}],note?}` → `{id,duplicate}`. All three locations are authorized on every stage.
- `transfers/approve|ship|receive|cancel`: `{transferId}`. Request → different-person approval → ship to in-transit → full receive; only pre-shipment cancellation. These are full-document stages, matching the old public workflow (no partial-receive editor).
- `counts/start`: `{locationId,countType?,blindCount?}`; `counts/submit`: `{sessionId,lines:[{lineId,countedBase}]}`; `counts/approve`: `{sessionId,reasonCode?}`; `counts/cancel`: `{sessionId}`. One snapshot contains at most 100 complete lines, not a truncated prefix. Version, movement ID, quantity and product/lot roster must remain unchanged at submit AND approval. Counter/creator cannot approve. Only the assigned counter can enter a blind session. Active blind counters are refused stock overview, lots, movement and negative-stock facts until completion, so those alternate reads cannot bypass the blind form.
- `adjustments/request`: `{adjustmentType?,reasonCode,note?,lines:[{productId,locationId,varianceBase,stockStatus?,lotId?,unitCostMinor?}]}`; `adjustments/decide`: `{adjustmentId,decision:'approved'|'rejected'}`; `adjustments/reverse`: `{adjustmentId,reason}`. Decisions/reversals require `inventory.approve`, NEVER the requester. This intentionally uses the brief's stricter grant instead of legacy `inventory.adjustment.approve`.
- `reservations/create`: `{reservationType?,sourceType?,sourceDocumentId,expiresAt?,lines:[{productId,locationId,quantityBase,lotId?}]}`; `reservations/release|consume`: `{reservationId}`. Exact allocated lots are retained. Expired reservations cannot be consumed; release is available.
- `quality/change`: `{lotId,locationId,fromStatus,toStatus,quantityBase,reasonCode,note?}`. Releasing to available requires `inventory.approve`; other changes require `inventory.write`. Expired lots cannot be released.
- `replenishment/save`: `{productId,locationId?,enabled?,reorderPointBase,targetLevelBase,safetyStockBase?,leadTimeDays?,alertCooldownMs?}`.
- `policies/save`: `{productId,trackingMode?,allocationPolicy?,allowMixedLotsPerLine?,qualityReleaseRequired?,expiryDateRequired?,manufactureDateRequired?,minimumRemainingShelfLifeDays?}`. National administration only; base UOM/scale are read from the catalog and never rewritten here.
- `negative/allow`: `{locationId,active,movementTypes,limitBase?,sourceRef}`. National admin only; distributor warehouses/zones/bins/trucks only.
- `negative/resolve`: `{flagId,note}`. Distinct authorized resolver, non-negative current balance required.

## Jobs, native seams and web mount

`inventory.expire-lots` runs at 00:15 Asia/Manila. It moves available/quality-held/quarantined due lot partitions to expired through posting, releases exact hard reservations first, and enqueues bounded 20-partition continuations. Lot issue validation refuses expired goods before the next job. In-transit lots remain in transit until disposition/receipt; the issue fence still refuses expired lots.

No inventory mobile op or projection is independently registered: D4's `field.bundle` is FIELDSYNC-owned and `van.bundle` plus trip/load/damage operations are VAN-owned. Inventory appends change entity `inventory_balances` with org-unit `scopeKey`; FIELDSYNC/VAN must map it into their bundle inventory DTOs. The sole posting seam is ready for those callers. Do not register an overlapping bundle from this lane.

`InventoryWorkspace({setupMessage})` retains its export and existing `/inventory` mount in `module-workspace.tsx`. `NegativeStockPanel({locations})` retains its export and `_id`-based location prop. Both use only the v2 API hooks (no Bun API imports). Default overview is exceptions → selling-value KPIs/location drills → trend → correct-unit stock/action table, with CSV/print. Receiving, staged transfers, blind counts, adjustments, stock-target editing, lot-quality actions, negative-stock controls and movement traces stay in workflow tabs. SAP/manufacturing stay hidden. Catalog/organization setup is owned elsewhere; the setup link is not a replacement demo seeder.

The ORG audit and ORDERS price and ANALYTICS refresh seams are intentionally not replaced in this lane. Integration must install the real owners. Tests mock those exact seams and profile/scope hooks while exercising real inventory SQL, migrations, cookies, transactions and HTTP. No live deployment/native-device claim follows from those tests.
