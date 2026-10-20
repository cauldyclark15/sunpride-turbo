# VANOPS — BB-09 / BB-14 / BB-15 / BB-18

## F-102 / F-103 — Review a route load, then scan load-out

Vans & cash has a scoped truck/seller/beat/depot planner. New trips with operational policies use `operations_version=1`; an explicit legacy downgrade is refused. Existing legacy trips are not rewritten.

The load suggestion freezes the day's roster and class mix, up to three completed route cycles, authorized open pre-sell order references, depot availability, rounding and the explanatory algorithm. The class-adjusted average is compared with committed demand using the maximum, not their sum. A reviewer edits quantities, checks capacity and applies the immutable suggestion through the existing load writer. Lot-tracked depot stock is allocated FEFO. A missing history is disclosed, not fabricated. Missing legacy service dates use the order's Manila creation day. Prior receipts without frozen outlet class use current class, explicitly provisional.

For a first route with no sales history or open pre-sell demand, the authorized depot's stocked products appear with zero forecasts and an explicit initial-load notice. The reviewer enters initial quantities rather than inventing offtake. A wholly zero load cannot be applied. Catalog overflow is refused explicitly; stock from other depots is never an initial-load candidate. The planner and policy pickers have exact, distinct accessible names independent of their option text.

The existing handheld load-out scan remains. A discrepancy requires independent office approval; it is not silently posted. Truck weight/volume capacity is an explicit human review, not an invented capacity number.

## F-104 — Lot ledger and FEFO

`vanOps` extends the existing v2 bundle without changing the frozen v1 wire validator. Released lots carry lot ID, printed batch, expiry, quality status and location stock status. The encrypted Room baseline plus unreflected immutable operations derives offline positions. FEFO rejects expiry at the boundary and excludes damaged, in-transit and non-released stock. It honors governed remaining shelf-life days and freezes exact allocations in each sale.

The API validates those exact allocations and posts them through `inventory/posting.js` only. Linked returns use the sold batch, not a fresh FEFO guess. Product and lot/status counts must both be complete and reconcile. Reload receipt retires in-transit positions before making the same batches available. No independent balance writer was added.

## F-105 — Required readings and actual stops

Opening and closing odometers are required for operational-version trips. Closing cannot precede the captured opening reading. A bootstrap carries the opening reading so a resumed phone does not lose this check.

Immutable `stop.record` arrival/departure evidence records the actual sequence, planned sequence, captured time and duration, with one open stop at a time. An open stop blocks local and server completion. Re-visits use different stop IDs. The web compares planned versus actual and shows both odometers. `callflow-config.js` is step configuration for CALLFLOW, not a second execution engine.

## F-113 — Controlled return evidence

The effective reason code list is the same on the handheld and API. A linked return retains quantity, sold batch/expiry/quality, an inline bounded JPEG, customer name and normalized signature strokes atomically in the encrypted outbox and server capture. Both sides validate bounds and the photo digest. A custom reason is conservative warehouse bad-stock receipt, not permission to resell, refund or dispose.

The pre-existing constraints on unlinked returns and dispositions needing separate office approval remain; they must not be presented as completed commercial refund/disposal workflows. The signed full-route test uses a linked damaged return. Frozen sale, payment and original sale operation are not rewritten.

## F-114 — Physical container custody and store debt

Issue, receive and physical count are distinct immutable facts. A van count establishes physical custody; store issues subtract, store receipts add. Each configured asset type must be counted before unload, including explicit zero counts. A store's outstanding debt is separate from a physical van count. Warehouse empties receipt retires van custody but does not erase what a store still owes. Quantities and discrepancies are shown in the trip review.

## F-115 — Frozen-goods cold chain (Must)

Effective-dated editable policies contain a default van band, optional product-specific bands and a reading interval. Load-out, interval and delivery readings save offline as manual operator-reported evidence; no probe-attestation claim is made. Start and each sale require the appropriate fresh reading. Unload and local completion require a fresh reading too.

Excursions and missed intervals require independent quality review. A later normal reading does not erase an earlier exception. An unresolved exception blocks departure / further selling; counts, unload capture and local completion remain possible. Office sign-off requires release. A quarantine decision cannot be received as sellable warehouse stock through this adapter: a governed warehouse quality-disposition integration is still needed for that branch.

## F-116 / F-117 — Unload and versioned settlement

The seller saves a complete batch/status unload manifest from the final physical count, with unsold/returned partitions and empties. This capture does not imply warehouse receipt or move stock to the depot. The warehouse independently records received quantities per batch; only that command posts a canonical unload movement. Product name and unit facts are frozen for display. A discrepancy blocks sign-off rather than disappearing.

The settlement freezes the physical explanation, load/reload/sale/return/void/damage events, stock count, cash/tender records, documents, operation manifest and odometers, with a version and SHA-256 content hash. Customer pickups add physical truck stock; they are not subtracted as depot returns. Local completion does not require online remittance, warehouse receipt or approval. Office remittance, reconciled warehouse receipt, resolved quality and variance exceptions, and an independent supervisor are required to approve. Approval durably requests SAP posting; it never pretends that SAP has posted.

The stock table and CSV distinguish opening load, received reloads, closing count, warehouse receipt and remaining truck stock. Warehouse receipt appends the stock explanation in the same transaction as the canonical movement. A rejected settlement is labelled returned for correction, not pending approval. Next actions follow the actual load/departure/quality/warehouse/sign-off stage. The Vans cockpit's existing `?trip=` drill-down and explicit `?tripId=` links both select the intended trip.

A rejected version may be followed by a new server submission. The handheld's correction / re-open UX and the governed resolution of a short warehouse receipt are not complete; captured evidence is never edited to work around them.

## F-118 — Variance escalation

The effective policy uses basis points of non-void van sales. The sample tolerance is 50 bp (0.5%) with a 24-hour deadline. Cash and absolute line-value differences cannot cancel each other out. An unknown variance value is an exception, never zero. Values are operational count estimates, not SAP valuation.

A breach goes to a supervisor, then a different area/region/national manager for recorded acceptance, investigation or recovery. A final actor cannot be the seller or the first reviewer. Open cases block sign-off. The deadline is visible; this lane does not claim an implemented notification service or a completed financial recovery posting.

## F-121 — En-route reload

A request does not add stock. Independent office approval and dispatch create separate immutable events. Dispatch posts depot stock to the truck's in-transit status. Receipt requires the exact dispatched batches and quantities, then posts in-transit → available and explains the reload in the trip ledger. A dispatched but unreceived reload blocks completion. A request made offline may sync after local completion, but it cannot then be fulfilled against a closed/counted trip.

## F-122 — Daily scorecard

The web and offline handheld show sales before returns, actual distinct-store calls, planned stores, strike rate, average buying-store drop, return documents, actual refunds, collection and variance. A sale does not invent a stop. Missing call facts produce an unknown strike rate. Credit promises are not collections. Monthly targets, previous trip and recent trend provide context; missing or ambiguous targets are disclosed. The phone overlays only operations not yet reflected in its authorized baseline.

## F-123 — Full-trip offline state

The existing encrypted Room outbox handles these operations; no second queue was added. An operational trip can count cash, count batches, save unload and close locally with pending uploads. Recording is still bounded by the verified scope/device lease and service day. Delayed upload retains the capture day and is accepted within seven days, subject to current persisted authorization.

Uploads select a FIFO prefix of at most 20 captures with a conservative UTF-8 byte budget, so a group of JPEG/signature returns does not exceed the core API's 1 MiB JSON cap. The operation objects, UUIDs and bytes are unchanged; acknowledgements still precede completion. Legacy sale and return captures do not acquire the new allocation fields.

State is local completion → pending sync → pending supervisor → approved / SAP pending → posted only after a genuine SAP acknowledgement. The local SAP adapter cannot prove the last state. Uncertain replies replay the same operation UUID and bytes; processed acknowledgements remain durable. Ordinary legacy trips retain their old behavior.

## F-102–F-123 — Seams and integration

- INVENTORY: existing `postMovement`, the sole canonical stock writer.
- CALLFLOW: `vanCallFlowSteps` in `callflow-config.js`; the shared engine owner must mount these step configurations. Route controls are capture tools, not a second flow engine.
- FISCAL: `seams.js` exposes `allocateDocumentNumber` (verifies existing encrypted-handset allocation) and `requestOverride` (delegates existing context-bound office approval codes). Reserved fiscal series, governed tenders and the shared override service remain FISCAL's authority.
- SAP: `sapCreditCheck` delegates the existing credit-replica seam; `enqueueSapPosting` durably requests a settlement posting in `van_sap_requests`. Replace these adapters with SAP's owned services at integration. No made-up SAP response is used.
- Migration range: 0440 closed-loop evidence/policies, 0441 reload transitions, 0442 reviewed load suggestions, 0443 stop times.
- Seed: idempotent sample policies are part of the normal demo ownership batch, so dependency-safe reset remains valid. Existing sample databases get additive policy installation; no live data reset is needed.

## F-102–F-123 — Verification boundaries

`vanops.test.js` and its route helper exercise signed HTTP push, actual PostgreSQL lot posting, office HTTP receipt / remittance / sign-off, duplicate replay, real trip-detail scorecard and reviewed load suggestions. The test replaces organizational lookup with a fixture seam; it is not a substitute for live role/phone proof. `van-load-suggestion.test.js`, `van-scorecard.test.js`, native FEFO tests and web rendering / exact-quantity tests cover pure contracts.

`RouteClosedLoopStoreTest` is an encrypted SQLCipher Room instrumentation test with a clearly marked fixture baseline and no transport. It covers offline capture / reopen and legacy wire preservation, not a live-server route. `VanOpsLiveProofTest` is a separate opt-in H10P proof: verified live bootstrap, Wi-Fi and mobile data disabled with USB reverse removed, production repository capture, the actual camera and signature canvas, encrypted local completion, immutable acknowledgement replay after reconnection and independent office sign-off. The host stages its private configuration outside the repository. The lane report records which tests actually ran, gate counts and vision-checked physical screenshots separately; the existence of the proof code is not a claim that it passed.

## Needs Sunpride

Approve storage bands, per-product overrides, reading interval, quality decision rights and quarantine disposition; return reasons and disposal/refund authority; asset types and starting custody; variance tolerance, deadline and financial recovery process; truck capacities; route-cycle definition and class-history provenance. Current values are explicitly sample defaults / our safe software design, not statements of Sunpride's existing operations.

## iOS parity later

Add the same versioned bundle extension, FEFO allocations, return JPEG/signature, stop/temperature/container/reload capture, complete lot counts, local close state and baseline-plus-outbox scorecard to iOS when its work resumes. No iOS source changed here.

## Bonus features changed

None intentionally removed. Existing location sharing, biometrics, password change, receipt printing, issue reporting and legacy trip support remain. Device tests use typed-password / non-biometric paths and the paper-print suite is excluded unless explicitly requested.
