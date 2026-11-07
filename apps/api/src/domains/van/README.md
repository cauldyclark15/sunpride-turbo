# Van lane (Bun / Postgres)

Owner question: is every truck's stock and money accounted for?

This is a local, partially integrated domain implementation, not a released handheld workflow. The registry is unchanged. Install through `install(router, ctx)` in `index.js` after the other lanes supply their named seams.

## Authority and settlement

- Only `inventory/posting.js::postMovement(tx, input)` writes canonical stock. Van keeps append-only explanation events, not balances. A load posts depot → truck; sale posts truck → outside; linked return and void compensate; damage uses two equal lines (available → outside, outside → damaged); rejection reverses these lines. Count adjustment and final depot hand-in also use the seam.
- Every mobile handler rechecks persisted profile, current assignment, active unit, bound van device and seller/trip ownership in its transaction. CORE reauthorizes before its op receipt lookup. A profile/device snapshot is not permission to write.
- CORE owns op replay: `subject + device + clientOpId`, canonical full payload/clientTime/dependencies, original ack and server time. Natural sale/return IDs additionally compare the complete captured request. Rejections roll back the domain, movement, change and receipt together.
- Money uses exact integer centavos, quantities exact base integers, safe-integer bounded before the posting seam. Receipt facts freeze customer, product, base scale/case size, governed price, payment label, seller and truck at acceptance. Later masters never relabel a saved receipt.
- `expected on truck = loaded − gross sold + voided + customer returns`; damage transfers available to damaged without removing physical stock. The pre-count expectation remains visible after count adjustment and unloading. Stock counts include available AND damaged, even when one is zero. Canonical stock is checked before and after reconciliation/unloading; unexplained stock changes fail closed.
- Stock value uses the canonical weighted average cost, with a null value when cost is unknown, never an invented zero. Cases/pieces use frozen catalog conversions, never an assumed case size. Mixed SKU base units are not labeled as cases.
- `cash expected = cash sales + cash collections − cash refunds − void refunds`. A handheld cash count is NOT a remittance. The office separately confirms cash receipt through `cash/remit`; closing requires this receipt, stock and cash counts, decided damage, reviewed variances and a manifest containing every accepted trip operation. The receiving person cannot be the seller. Hand-in must equal the recorded count; a changed count needs office correction rather than silent overwrite.
- Defaults remain OUR defaults, not confirmed Sunpride rules: one open trip per truck/seller/day, one load/no top-up, all voids approved, cash approval above ₱50 either way, all stock differences approved, damage approval at 12 units and JPEG evidence up to 90,000 bytes. Walk-ins and ungoverned promotions fail closed.

## HTTP (cookie session)

Every POST needs `Idempotency-Key`. Payloads below are JSON; UUIDs remain strings. POST results always include the IDs affected. Authorization is checked again before replay; changed request facts under one key conflict. The web does not retry commands automatically.

| Method/path under `/api/v1/van/` | Payload/query                                                                                     | Grant                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| GET `trips`                      | `date=YYYY-MM-DD`, optional `format=csv`                                                          | van.read, current scope; sales own trips |
| GET `trip`                       | `tripId`                                                                                          | same                                     |
| GET `vehicles`                   | none                                                                                              | van.read, current scope                  |
| GET `damage`                     | optional numeric `cursor`; pending rows, 20/page                                                  | van.read, current scope; sales own rows  |
| GET `damage-photo`               | `damageId`; private JPEG, no-store                                                                | authorized trip read                     |
| POST `vehicles/create`           | `{orgUnitId,vehicleCode,plateNumber,truckLocationId,homeLocationId,name?,capacityNote?}`          | van.manage at vehicle/truck/depot        |
| POST `trips/plan`                | `{vehicleId,salespersonProfileId,serviceDate,sourceLocationId?,routeId?,driverName?,helperName?}` | van.manage at every resource             |
| POST `trips/cancel`              | `{tripId,reason}`; only unloaded planned/loading                                                  | van.manage                               |
| POST `loads/plan`                | `{tripId,lines:[{productId,expectedBase,lotId?}]}`; 1–100 lines                                   | van.manage                               |
| POST `loads/approve`             | `{tripId,note?}`; independent discrepancy approval                                                | van.load.approve                         |
| POST `damage/decide`             | `{damageId,decision:'approve'                                                                     | 'reject',note?}`; rejection needs note   | van.damage.approve; not recorder   |
| POST `credit/set`                | `{outletId,effectiveFrom:<epoch-ms>,sourceRef,terms:null                                          | {termsDays,creditLimitMinor}}`           | van.manage at current outlet owner |
| POST `cash/remit`                | `{tripId,amountMinor,reference}`                                                                  | van.cash.approve; not seller             |
| POST `void/approval-code`        | `{receiptNumber,totalMinor,reasonCode}`                                                           | van.void.approve; not seller             |
| POST `refund/approval-code`      | `{receiptNumber,totalMinor,reasonCode,refundNumber}`                                              | van.refund.approve; not seller           |
| POST `cash/approval-code`        | `{tripNumber,expectedMinor,declaredMinor,reasonCode}`                                             | van.cash.approve; not seller             |
| POST `stock/approval-code`       | `{tripNumber,countCode,varianceLines,shortBase,overBase}`                                         | van.stock.approve; not seller            |

Approval responses retain the requested facts plus `{code,tripNumber,tripId,approvalKind}`; cash also returns `varianceMinor`. Codes retain the frozen native v1 HMAC algorithms under `SYNC_CURSOR_SECRET` with distinct purpose labels. The approval row stores issuer and a facts hash, NOT the code. The web replay store also omits the code and recomputes it. Server consumption requires a real, independently issued approval row as well as the matching code; knowing a downloaded offline trip key is not office authority.

`trips` returns `{date,asOf,targetCentavos:null,targetStatus:'needs_setup',priorDate,priorSalesCentavos,trend:[{date,salesCentavos}],rows:[TripSettlement]}`. There is an explicit 500-trip overflow failure, no silent list cap. `TripSettlement` is shared with the web in `apps/web/src/components/van/model.ts`: truck/seller/unit/route/status, stock by product (loaded, sold, voided, returned, damaged, unloaded, expected, counted, variance and value), separate expected/counted/remitted cash and receiver/approver attribution, frozen receipts, returns, payments, load and audit history, next action. CSV uses BOM/RFC-4180/formula-prefix protection.

## Sync, realtime and analytics

`van.bundle` params: `{serviceDate:'YYYY-MM-DD'}`. Root data keys are exactly `{serviceDate,seller,policy,trip,load,truckStock,products,customers,priceLines,damageRecords,promotions}` (D4/B2 DTO fields, decimal strings for scaled quantities and money). Current-day own-seller/device only. Bounded full snapshot, with explicit overflow failure rather than partial arrays. Governed price windows come from the actual resolved price list line. Missing prices/terms stay missing; `products.unit_price` is never a selling authority.

Registered ops (CORE D5 envelope): `trip.start`, `load.confirm`, `truck.damage`, `sale.record`, `sale.void`, `return.record`, `payment.record`, `cash.reconcile`, `stock.reconcile`, `trip.close`. Existing three ops retain B2 payloads. Parked ops retain the checked-in native capture fields, not new copies of the v1 fixtures. `payment.record` is an explicit new van-owned extension: `{tripId,saleId,paymentId?,method,amountMinor,reference?,deviceTime}`; only collections against an unvoided credit sale of this trip, within remaining exposure. A linked return may explicitly include `refund:{method,amountMinor}`; stock returns do not implicitly invent a refund.

Writes append `van.bundle` change entries keyed by `profile:<seller-profile-id>` and publish topic `van`. A coalesced durable `van.refresh` job calls `enqueueRefresh(ctx,{kind:'van',date,unitId})` AFTER commit, so transaction rollback cannot leak an analytics refresh.

## Media integration (VISITS owns the hook)

Export `canClaimMedia(db, actor, {purpose,ownerId,deviceId})` from `media.js`. VISITS must dispatch purpose `truck-damage` to it; do not replace the shared hook from this lane. Other purposes return false here. It checks current persisted person/device/assignment, van app, own active current-day trip and device binding. `ownerId` may be that trip UUID or null for the single server-resolved active trip. Attachment by `truck.damage.photoSha256` rechecks stored file status, JPEG/size, uploader user, exact device, purpose, trip-or-null owner, creation after this trip and one-time use. The digest cannot claim a different person's or earlier trip's file. A null owner is accepted only while resolving the one current active trip; clients should send the explicit trip ID.

## Mounts

- `VanTripsWorkspace({initialDate?,initialTripId?})` exported from `components/van/index.ts`; mount on the COCKPIT lane's Vans & cash page. Pass the route's `date`/`tripId` query values for hydration; selections update both URL values. It shows variance-first trucks, sales versus prior day, trend, target-needs-setup, drill-through settlement, cash hand-in, CSV and print.
- `VanVoidApproval`, `VanCashApproval`, `VanStockApproval`, `VanDamageApprovals` retain original names/props and existing `/workflows` mounts. All use the API/auth data layer; no Bun API runtime/types in these components. The shared module-workspace SSR test only gained the new permissions-provider mock, with no test or assertion removed.
- The target link proposes `/sales-targets`; COCKPIT should align this with its final Sales & targets slug.

## Remaining integration / deliberate limits

1. CORE has no snapshot-only projection option. Since-null gives the complete D4 snapshot; a since-cursor request is explicitly refused with `409 cursor_invalid`, action `rebootstrap`, rather than mislabeling a replacement as a delta. This is NOT the D4 minimal compromise's snapshot mode on every delta cycle. CORE must add snapshot-only support; native VAN must use since-null until then. No core/registry edits were made here.
2. F-502/F-503/F-511 now negotiate `schemeEngine:1` in the v2 bundle. `policy.schemes` carries outlet/SKU-authorized rules, original resolved price-list identities, bounded validity, active accounting-link state and the seller's effective fiscal bands. New native checkout executes the bundled canonical JS authority and sends `schemeEngineVersion:1`; server capture reconstructs paid/free quantities, verifies exact allocations, enforces the same financial bands and records valued campaign spend/deferred van-sale earnings transactionally. Out-of-band offline benefits are blocked; no phone-generated approval is trusted. Frozen v1 clients retain their compatibility DTO/path, not advanced scheme admission. Walk-ins, unlinked returns and broader return-disposition limits remain separate from this promotion delivery.
3. Sales targets are not integrated from ANALYTICS, so the page labels them Needs setup rather than inventing targets. Existing source targets must be wired before owner-target acceptance.
4. Inventory route-session/lease/checkpoint writers are outside this lane and not part of the named posting seam. `routeSessionId` remains null on newly started trips; domain trip/device guards do not pretend to issue a canonical inventory lease. Lot-specific damage/reversal allocation provenance and expired-lot selection need the INVENTORY seam to expose/retain allocation results.
5. The full van bundle is one bounded snapshot, not a multi-page point-in-time history. Live concurrent source-read snapshot consistency beyond that transaction remains integration work. No production rollout, physical device, printer or signed-in live-owner browser proof is claimed.
6. Vehicle status editing, manual office leftover-return/close variants, broad return approval and cancellation of a posted load are not implemented. Office planning, native settlement/unload, unposted cancellation and independent discrepancy/damage decisions are implemented.
