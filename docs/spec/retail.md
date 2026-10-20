# Retail POS configuration (Track R)

## F-R01 — Delivered foundation, not a store-checkout release

The existing van POS APK negotiates `posMode:true` on `van.bundle`. An effective-dated device assignment selects Van or Store. Unconfigured devices keep the original Van contract. Store mode returns no fabricated trip, load or route, hides those screens and rejects van operations at the server. Office mode changes are refused while a registered cashier session or started van trip is open.

A store is an `inventory_locations` row of type `store`, with the same canonical balances, movements and ledger as every warehouse/truck. Registers reference those locations; cashier assignments and tolerance policies are effective-dated and editable in Setup → Phones. Two ownership-marked sample Cebu stores are added idempotently by the demo and daily seed without assigning any real device.

Store mode currently enables cashier sessions only. The UI explicitly says checkout is not enabled. There is no local retail price list, fake receipt, invented statutory read, parallel inventory ledger or fabricated sales total.

## F-R01 — Cashier session wire and controls

The existing encrypted Room outbox queues `store.shift.open` and `store.shift.close` through `/api/sync/push`. Opening captures a client UUID, opening float and frozen mode/policy versions. Closing submits a blind declared amount without an expected balance or client-calculated variance. Locally queued close depends on the opening request. A lease/scope hold refuses further recording; the queue and exact operation bytes survive a process/database reopen.

The server repeats persisted profile, employment, device, binding, register ownership and cashier authorization inside the business transaction. A per-register lock prevents concurrent sessions. Offline captures are bounded to seven days and reject future clocks. Core owns duplicate receipts and altered-payload replay detection. Shift opens, declarations and decisions are immutable and audited through the existing fiscal audit mechanism. Only an independent `van.cash.approve` caller receives expected/variance facts and may decide an escalated declaration; the cashier never receives them. Larger-than-tolerance differences appear on Decide. Equal tolerance does not escalate.

At this foundation stage the opening float is the only permitted register cash movement, because retail transactions are disabled. The shared tender journal must be integrated before enabling sales. Do not interpret this as a production-ready cash close for a selling store.

## F-R01 — Office endpoints

All POSTs require `requestKey` UUID and fresh target authorization before the saved command response can be replayed.

- `GET /api/v1/storepos/workspace`: current locations/registers/devices/people and the latest 500 scoped cashier sessions; overflow is explicit.
- `POST /api/v1/storepos/registers/save`: `{locationId, terminalCode, name, id?}`.
- `POST /api/v1/storepos/cashiers/save`: `{registerId, profileId, enabled}`.
- `POST /api/v1/storepos/policies/save`: `{registerId, toleranceCentavos}`. A new current effective version, never a rewrite of a submitted count's policy.
- `POST /api/v1/storepos/mode/set`: `{deviceId, registerId|null, mode:'van'|'store', allowLocalSwitch:false}`.
- `POST /api/v1/storepos/shifts/decide`: `{closureId, decision:'accepted'|'investigate', reason}`. No self-decision.
- Topic: `storepos`; the existing `van` topic also invalidates on office changes.

A manager-PIN switch is not implemented or advertised as available. `allowLocalSwitch:true` fails closed. This is an explicit remaining part of the mode requirement, not a client-data dependency.

## F-R02 / F-R03 — Shared authority integration remaining

`SEAM(ORDERS)` marks the disabled transaction boundary. Extend the existing POS sale/void/return objects to accept a cashier session as their operational context, rather than minting fake vehicle/trip rows. Continue using shared `orders/pricing.js`, TPM, inventory `postMovement`, fiscal allocations/documents and SAP posting adapters. No retail sale API or store transaction engine is delivered by this change.

Cash/e-wallet/card split tender, receipt-linked refunds with approval, frozen fiscal receipts, mid-shift X reads, monotonic Z reads, VAT and e-journal export remain. Enabling checkout before the shared tender-derived cash expectation and analytics projection land is unsafe. No BIR/PTU compliance claim is made.

## F-R04 / F-R05 — Canonical stock integration remaining

The canonical location type and location-save validation accept `store`. Existing warehouse transfer, goods-receipt and stock-count/reconciliation APIs remain authoritative. Native store receiving/count screens and reorder-point-to-approved-transfer workflows are not implemented. No second stock ledger has been created.

## F-R06 / F-R07 — Remaining store extensions

Deposit photo/bank/Z-read matching, discrepancy escalation, phone-based customer lookup, optional points earn/redeem and supervisor-PIN employee discounts are not implemented. Do not enable UI controls that imply these writes exist.

## F-R08 — Remaining management integration

The office can inspect cashier sessions and independently review cash differences in Decide. Store sales/targets/prior-period/trends/category/basket/shrink reporting and Excel export are not implemented. No separate retail sales number is emitted. The future store-sale projection must enter the existing canonical commercial facts and analytics warehouse, not a parallel dashboard calculation.

## F-R01–F-R08 — Needs Sunpride

Sample Cebu stores and the ₱50 over/short tolerance are invented, ownership-marked sample data, not observed store operations. Sunpride must eventually confirm store ownership, terminals/cashiers, tolerance and approval policy, opening-float practice, BIR/PTU series, deposit matching, loyalty and employee-discount policy. None of those missing answers was treated as a reason to block foundation delivery.

## F-R01–F-R08 — iOS parity later

No iOS source changes. If a retail iOS app becomes in scope, negotiate the same device-mode/session contract and reuse encrypted outbox and shared checkout authorities; do not fork a retail app or policy engine. iOS remains paused.
