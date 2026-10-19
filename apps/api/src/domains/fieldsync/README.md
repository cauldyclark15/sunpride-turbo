# Field sync domain (v2)

Owner question: who has not done their planned calls, whose work needs a check-in, and what did each person actually do that day?

This installer owns mobile field projections and continuous location, not the sync engine, device enrollment, visits, stock posting or van settlement. It uses the core signed `/api/sync/pull` and `/api/sync/push` without changing their v2 envelopes.

## Projections

- `field.bundle`, params `{dayFrom: "YYYY-MM-DD"}`: the caller's current Manila day plus the existing three-day planned-visit horizon. Its data keys are exactly the D4 dictionary: `permissions`, `employee`, `scope`, `appConfig`, `plannedVisits`, `outlets`, `localCustomers`, `route`, `tasks`, `productCatalog`, `inventoryAvailability`, `callSheets`, `orderTerms`, `accountSummaries`, `activityRules`, `photoTypes`, `dayTarget`, `daySales`.
  - Plans must be approved/active, with persisted approval signature and content hash. Stop names and order come from approved snapshots; navigation uses an unambiguous current verified pin. Current outlet ownership is checked again.
  - Catalog is the union of the planned stores' current call-sheet catalogs and assortments, never every nationwide product. Product selling units, rational conversions, active barcodes and scoped selling-location inventory are projected explicitly. There is no extra `assortments` top-level key: the closed D4 dictionary has none.
  - Account prices use `orders/pricing.js:resolvePrice` for every selling unit. Legacy `products.unit_price` is never a price authority. The D4 initial flags remain capture disabled / prices unavailable / promotions unavailable; account terms still carry governed prices.
  - Account summaries cover 91 days, with a 28-day recent window and all authorized open orders, not AR. A shared customer is withheld unless every current linked outlet is in the downloaded plan. Source person, current customer/outlet ownership and stored source location are independently authorized. Summary availability is `available | withheld`, with explicit null figures when withheld.
  - Snapshot arrays are sliced with the core page limit; clients must stage the entire typed generation. A changed snapshot digest refuses continuation. Safe integer or bounded-source overflow fails closed, never silently truncates the catalog.
  - Delta entities: `visit`, `activity`, `inventory`. Unsupported plan/assignment/reference mutations produce `field.manifest`, which returns HTTP 409 `rebootstrap_required`, action `rebootstrap`. Deleted/withdrawn values become tombstones through the core engine.
- `field.sales`, params `{profileId, serviceDate}`: exactly `{serviceDate,targets:{daily,monthly},totals:{todaySales,todayPct,mtdSales},calls:{productiveCallRule}}`. Account summaries are in `field.bundle`, not extra keys here. Target amounts are converted from the frozen numeric-peso schema into integer centavos. Missing targets are null.
- `team.summary`, params `{serviceDate,directOnly}`: D4 team dictionary, boolean `inProgress`, governed persisted productive results, route-order violations, location and late-sync exceptions. Requires people read permission; managers see only their current team within organizational scope. At most 50 exception rows are displayed; totals remain complete and `truncated` is explicit.
- `suggested-order`, params `{outletId,asOfDate}`: D4 suggestion dictionary. Envelope `version` is numeric `2`; the nested recommendation version is the string `suggested-order/v2`, matching the native DTO's string type. Without an analytics recommendation model, returns empty `lines` and `historyStatus: "analytics_unavailable"`, not invented recommendations. Existing provisional horizon defaults are a seven-day cycle and one-day lead time.

The three on-demand reports are snapshots. Their cached cursor does not replace the execution cursor; attempts to delta them ask for a new snapshot.

### Optional analytics read model

If ANALYTICS provides `public.analytics_suggested_orders` (table or view), it is read by `outlet_id` and `as_of_date`. Columns: `product_id`, `code`, `name`, `unit`, `status`, `suggested_quantity` (nullable safe integer), `reasons` (text array or JSON array). This domain never writes it. The frozen analytics schema has no recommendation table, so absence is a supported explicit-unavailable state. The actual recommended quantity must come from ANALYTICS, not a heuristic in this lane.

## Manifest fence and integration

Migration `0230_fieldsync.sql` adds only this lane's state, the live-head movement timestamp and observational invalidation triggers. The triggers do not change other domains' business rows. They are deferred until commit, acquire the same change-log ordering lock as core, and write a profile-scoped or conservative global `field.manifest` invalidation. Thus other lanes need not remember a new callback on every plan/reference write.

The bounded effective-day manifest also detects a scheduled employee/outlet/territory/route assignment, pin, assortment or price becoming current without a new write. Its invalidation is committed before the request is refused. Bootstrapping again cannot make an older cursor valid. Global reference invalidation is deliberately broader than necessary; it trades extra snapshots for no stale authorization/catalog.

VISITS and INVENTORY still need to call the existing core `recordChange` seam when their rows change. Accepted entity names are `visit`, `activity`, `inventory`, scoped as `profile:<profileId>` or `unit:<unitId>`; no Convex document shapes are serialized. ORG must install its real scope hooks. Pricing comes from ORDERS. These seam owners remain placeholders in the isolated lane and are mocked in the integration tests, as the shared brief requires.

## Location commands and reads

`location.record` is exactly one D5 ping: `{clientPingId,recordedAt,latitude,longitude,accuracyMeters,speedMetersPerSecond,headingDegrees,batteryPercent,mockLocation,provider,trigger,visitId?}` for field, or `tripId` for van. Nullable fix fields stay explicit null. `clientOpId == clientPingId`, `clientTime == recordedAt`. Core owns the maximum 100 pure location operations, proof, receipts and replay. Ack is `{entityId: <ping UUID>,eventIds:[],movementId:null,serverTime}`.

- Consent is explicit and append-only. A ping must have consent at capture time. A buffered pre-withdrawal fix cannot resume live sharing after consent withdrawal or End day.
- Field pings require an actual first server check-in and must not be later than recorded End day. The legacy 05:00 lower work-hour default is retained; all recording stops at 22:00 Manila. A field `stop` is treated as End day.
- Van pings require the caller's trip, its bound starting device, active/closing/reconciling status, matching service day and an instant between trip start and close. The same 22:00 maximum applies. No stock, cash or settlement facts are written here.
- Buffered pings older than seven days, fixes over five minutes in the future, invalid fix values and sub-ten-second non-start/stop pings are refused using D5's closed business-refusal codes. Older buffered fixes do not rewind the live head.

Additional authenticated command seams needed by the native adapters (outside this lane's native-file ownership):

- `GET /api/v1/location/consent` -> `{enabled,effectiveFrom}` for self.
- `POST /api/v1/location/consent`, body `{enabled:boolean}` -> `{id,enabled,effectiveFrom}`. No implicit enrollment consent. Native adapters must opt in after the user enables sharing; otherwise pings fail closed.
- `POST /api/v1/location/end-day`, body `{}` -> `{serviceDate,ended:true}` for self. Native End day should call this, even if a final stop ping cannot be captured.

Reads:

- `GET /api/v1/location/live?orgUnitId?&teamId?` -> `{now,truncated,selfOnly,positions,units,teams,trend,prior,idleThresholdMinutes:45,provisional:true}`. Positions retain the web map DTO and add `planned`, `visited`, `productive`, `lastSeenAt`, `lastMovedAt`, `lastActivityAt`, `freshness`, `idleFlag`. Status: `moving | idle | at-store | stale | offline`. Stationary status is separate from the 45-minute idle flag. Sales sees self; managers see their current team, never same-unit peers merely sharing an area. Trend/prior totals cover the visible people sharing a position, deduplicated across field/truck heads, not the whole sales force.
- `GET /api/v1/location/trail?profileId=<UUID>&date=YYYY-MM-DD` -> `{profileId,name,serviceDate,truncated,pings,stops,distanceKm,distanceBasis:"recorded_fixes",plannedStops}`. Fixes and visit stops are time ordered; signed planned order and off-plan stops are separate. Distance is great-circle distance along received fixes, not road distance or route profitability.
- `GET /api/v1/location/store-pins?cursor?` -> `{items,nextCursor}`. Verified pins are scope-filtered before keyset paging. Sales pins are restricted to their planned stores.

Topic `location` is capability-gated and emitted by one durable coalesced job no more than once per five-second pending window. The web also refreshes every 30 seconds so silent phones' freshness/idle states age.

## Jobs

- `fieldsync.location-purge`: 19:40 Asia/Manila, physically removes pings and live positions older than 90 days, 500 rows per table per transaction, with durable continuation and coordinate-free count audit.
- `fieldsync.day-close`: 22:00 Asia/Manila, creates/closes first-check-in work days and ends live tracking in bounded batches. An hourly catch-up handles missed close ticks after restart. It never completes a visit, certifies productivity or settles money.
- Only while `domains/van/index.js` still has its placeholder marker, day close changes unclosed `van_trips.status` to `review_required`. No other trip field is changed. Once VAN is installed, this fallback is automatically disabled; VAN owns actual trip close/reconciliation.

## Web mount and proof

`LiveMapWorkspace` and `LiveMapView` exports/props are retained, so the existing `/live-map` mount in `module-workspace.tsx` needs no change. Components now use the Bun data layer and their own DTOs, not Convex hooks/generated types. The map shows planned/visited/productive, last movement age, a provisional idle check-in prompt, prior day and seven-day coverage, scoped filters, signed route order and off-plan visits. Denied reads hide cached positions. The Google Maps browser-key path and Google-load-failure -> Leaflet/OpenStreetMap fallback are unchanged.

Tests execute the real core HTTP/device-proof/cursor/operation harness against disposable lane Postgres databases, with only the absent ORG/pricing seams mocked. Web proof is the component/model suite, not a native device run or a hosted Home/Reports walkthrough. There are no installs, shared database migrations, pushes or deployments in this lane.
