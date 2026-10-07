# Van-sales Android core

This is a separate application (`com.sunpride.van`, installed DEV ID `com.sunpride.van.dev`), not the field application with POS enabled. It shares protocols and deliberately ports patterns, not imports, from `apps/field-android`. The gateway is `/van/v1/bootstrap` and `/van/v1/push`, and every device lookup/proof uses `VAN_ANDROID`.

## Packages

- `auth`: Better Auth sign-in/session/JWT, encrypted session vault, Convex function envelopes, enrollment state machine and fixed/redacted failures.
- `device`: non-exportable Android Keystore P-256 key, strict DER/P1363 conversion and request proof generation.
- `storage`: SQLCipher-only Room v1 database, independent wrapped install passphrase, scoped rows, transactional snapshot/outbox/ack operations and pure outbox rules.
- `ledger`: integer truck-stock projection and local movement API. LOAD and DAMAGE are restricted to their server-confirmed/atomic paths.
- `ids`: transactional persisted sequence allocation and immutable receipt/idempotency pairs.
- `sync`: strict schema/typed codecs, authenticated signed transport, process-wide partition single-flight engine, WorkManager scheduling and DEBUG fixture backend.
- `data`: typed UI-facing models and `VanRepository` facade; no Compose state and no printing/scanner dependencies.
- `diagnostics`: allowlisted debug events, redaction, bounded no-backup breadcrumbs and an opaque support handle. No request bodies, bearer tokens, passwords or Throwable text are logged.

## UI integration: exact API

Import `com.sunpride.van.data.VanRepository` and the models in `com.sunpride.van.data`. Enrollment types are in `com.sunpride.van.auth`.

```kotlin
fun VanRepository.Companion.create(
    context: Context,
    intent: Intent? = null,
    stubMode: String? = null,
    environment: AppEnvironment = AppEnvironment(
        BuildConfig.CONVEX_SITE_URL, BuildConfig.CONVEX_URL
    )
): VanRepository

// Repository properties
val sessionState: StateFlow<SessionState>
val enrollmentState: StateFlow<EnrollmentState>
val currentTrip: Flow<Trip?>
val load: Flow<Load?>
val loadLines: Flow<List<LoadLine>>
val seller: Flow<Seller?>
val policy: Flow<VanPolicy?>
val truckStock: Flow<List<TruckStock>>
val products: Flow<List<Product>>
val customers: Flow<List<Customer>>
val syncStatus: Flow<SyncStatus>

suspend fun restoreSession(): Unit
suspend fun signIn(email: String, password: String): Unit
suspend fun refreshEnrollment(): EnrollmentState
suspend fun signOut(): Unit

suspend fun startTrip(
    vehicleConfirmed: Boolean,
    routeConfirmed: Boolean,
    driverName: String? = null,
    helperName: String? = null,
    odometerKm: Double? = null,
    note: String? = null
): String
suspend fun confirmLoad(lines: List<LoadActual>): String
suspend fun recordDamage(
    productId: String, qty: Long, reason: String, note: String? = null
): String
suspend fun canRemove(productId: String, qty: Long): Boolean
suspend fun addWalkInCustomer(name: String, reason: String): Customer
suspend fun issueTransactionId(): TransactionIdentity
suspend fun syncNow(): Unit
fun close(): Unit
```

`TransactionIdentity` is in `com.sunpride.van.ids` and has `receiptNumber: String` and `idempotencyKey: String`. Command strings are stable UUID-v4 client request IDs, not server IDs or acknowledgments. Commands return after the encrypted transaction and best-effort WorkManager scheduling; they do not wait for HTTP delivery. `syncNow()` waits for actual synchronization and can throw a fixed `AuthFailure`, `VanSyncFailure`, or `VanWireFailure`. Do not display arbitrary exception messages or server text.

`SessionState(signedIn: Boolean = false, offlinePending: Boolean = false)` contains no token. `EnrollmentState` is `SignedOut`, `Unregistered`, `Ready(deviceId)`, or `Removed`. Offline restoration can expose the previously authenticated/bound encrypted partition while `offlinePending` is true; it does not claim renewed online enrollment. Call `restoreSession()` from the UI lifecycle, and call `refreshEnrollment()` for Check again/polling. HTTP and Keystore initialization run off Main; collect flows on Main for Compose and never keep a password in saved instance state.

`Trip` includes IDs/number/status/serviceDate, nullable `Vehicle` and `Route`, nullable driver/helper, truck location/session, nullable start time, and `startPending`. `Trip.statusLabel` says **Starting… waiting for sync** until an ack is durable. The server must report a posted load (`trip.status == loaded`) before Start can queue.

`Load` has `loadId`, `status`, `lines`, and `confirmPending`. A `LoadLine` has server `expectedBase`, nullable server `actualBase`/`discrepancyReason`, and separate nullable `pendingActualBase`/`pendingReason`. Do not present pending actuals as stock. `LoadActual(lineNumber: Int, actualBase: Long, reason: String? = null)` is the command input. A changed quantity requires an allowed discrepancy reason, and every sheet line must appear exactly once.

`TruckStock(productId, availableBase: Long, damagedBase: Long)` is a local projection. `Product` has code/name/UOM/scale, all bootstrap barcodes and optional `barcodeUnits` (`BarcodeUnit(barcode, uomCode, baseQuantity?)`, VAN-009), with `displayQuantity(base: Long): String`. Quantities stay integral in storage and divide by `quantityScale` only for display; prices never derive from stock or product data.

`Customer` exposes outlet ID, code/name/address, sequence, `source` (`route`, `unplanned`, `walk_in`), nullable reason and `localOnly`. Filter this single scoped flow for route/unplanned/walk-in lists. Local walk-ins require a nonblank name and reason, require `walkInAllowed`, survive snapshot replacement, and are never silently uploaded as real outlet IDs.

`SyncStatus` has `queued`, `sending`, `review`, `held`, nullable `lastSyncTime`, and `health`. Counts and last successful sync come from Room. Review includes both rejected and conflicting operations. A successful HTTP response alone does not mean all local work was accepted.

## Auth and storage security

Sign-in sends JSON to `/api/auth/sign-in/email`, omits Origin and cookies, prefers `set-auth-token` and otherwise validates the top-level JSON session token. JWT exchange uses the session bearer at `/api/auth/convex/token`; the JWT remains in memory and refreshes before expiry. Convex `/api/query|mutation` responses are decoded as envelopes, including HTTP 560 function errors; a JWT 401 gets one refresh/retry. Errors never display raw server messages.

Session AES-256-GCM and database passphrase AES-256-GCM use separate Keystore aliases. The SQLCipher passphrase is ASCII-hex encoding of 32 random bytes; only its wrapped IV/ciphertext is persisted. SQLCipher 4.12.0 is explicitly loaded with `System.loadLibrary("sqlcipher")`, and every production open uses `SupportOpenHelperFactory`. Missing/corrupt key material refuses access. There is no plaintext fallback, destructive migration, or sign-out database-key wipe.

All 19 v1 tables are partitioned by `StoreScope(fullAuthSubject, deviceId)`. The full auth identity is `issuer|subject`, never a stripped subject, profile display name or arbitrary UI selection. The repository saves the identity index under a digest of the encrypted session token, so another session cannot select an old account's partition. Caller-created Room scopes are for core tests/authorized integration only; the UI uses the repository.

Schema v1 is exported at `app/schemas/com.sunpride.van.storage.VanDatabase/1.json`. Snapshot tables are `trip`, `load_line`, `product`, `customer` and `truck_stock_baseline`. Work/evidence tables are `stock_movement`, append-only `movement_settlement`, `outbox`, `ack`, `sync_meta`, `sequence_counter`, and immutable `transaction_id`. Future financial workflow tables are `sale`, `sale_line`, `payment`, `customer_return`, `return_line`, `reconciliation` and `price_list_line`.

`com.sunpride.van.pos.ProductSearch(products, stock, prices, now)` is the pure POS search index (VAN-008): `search(query, limit = 60)` returns ranked `PosProductHit(product, availableBase, price, match)` and `resolveScan(code)` (VAN-009) returns `ScanHit(hit, candidate)` rows from `BarcodeLookup`; `byBarcode(code)` is the single unambiguous scan result. `BarcodeLookup(products).resolve(code)` matches, stopping at the first level with a result: exact barcode (CR/LF suffix and AIM `]xx` prefix removed), the same GTIN in another length (UPC-A/EAN-13/GTIN-14 zero-padded), a GS1 AI (01) element string with a valid check digit, then an exact product code. Each `ScanCandidate` carries the scanned unit from the bootstrap's optional `barcodeUnits` (`uomCode`, `baseQuantity` of one scan, null when the office has no exact conversion); a cache without `barcodeUnits` reports the unit as not confirmed rather than assuming the selling unit. `PriceResolver` returns a `PosPrice` only when exactly one effective, non-negative `price_list_line` row exists for the product's own UOM at `now`; conflicting lists, other UOMs, future/expired rows yield null (**Priced by the office**). `VanRepository.priceLines` exposes the scoped `price_list_line` table as `PriceLine` (a read-only DAO flow; no schema change).

Sale/payment prices and totals are nullable, not zero: UI wording is **Priced by the office**. Payments record the office-configured method (VAN-012, below). The price-list table remains empty until the governed feed exists. These are schema provisions, not a completed sale/payment/return/reconciliation submission workflow.

## Checkout (VAN-011)

`com.sunpride.van.pos.CheckoutRules.evaluate(CheckoutRequest, CheckoutContext)` is the pure checkout check shared by the screens and the store. It returns a `CheckoutQuote` (lines, currency, integer total, tendered, change) or typed `CheckoutIssue`s; nothing is rounded:

- **Trip:** selling needs the trip on route or its start saved on this phone, a bootstrapped policy and an unheld partition.
- **Customer:** the customer must exist in this partition (route, unplanned, or a local walk-in).
- **Cart:** 1–100 lines, one line per product, positive integral base quantities, known products.
- **Stock:** each line needs that much **available** truck stock (damaged stock never sells) unless the office policy allows negative stock.
- **Price:** each line needs exactly one effective price for the product's own UOM (`PriceResolver`); otherwise the line is **Priced by the office** and the sale cannot complete (ADR-008: the handheld never defines a price). Line total = unit price × base ÷ quantity scale and must be a whole number of centavos; mixed currencies and totals above ₱10 billion refuse. Each line records the agreeing price-list IDs as its price source.
- **Payment:** one of the office's configured methods (VAN-012, below).

`RoomVanStore.commitSale(request, expectedTotalMinor)` (repository `completeSale`) runs the same rules again inside **one** Room transaction against the stored trip, customers, stock projection and price list, refuses `PRICES_CHANGED` if the total differs from what the seller showed the customer, then writes: the receipt number/idempotency pair (`TransactionIds`), `sale` (`saved`), `sale_line`s, one `payment` (method per VAN-012), a SALE movement per line (see below), and the `sale.record` outbox operation. Any failure rolls everything back, including the receipt number. The cart's UUID-v4 `saleId` makes a repeated Complete return the saved sale (`replay = true`) instead of selling twice.

The van gateway (`/van/v1/push`) has no sale operation yet and the server has no governed price list to re-price a sale, so the outbox row is written with status `parked` (`SALE_PARKED`): it holds the frozen operation bytes, is never selected by the sync engine, is counted as `SyncStatus.savedSales`, and its stock stays deducted across later bootstraps (an unacknowledged movement never settles). A later gateway lane adds `sale.record` to the van-v1 contract and promotes parked rows to `pending`; parked bytes have not been sent, so that lane may still adjust the payload shape. Receipt printing of the sale, credit terms and server posting are separate issues.

### Truck stock deduction on sale (VAN-018)

The deduction is part of the sale, never a separate step. Inside the same `commitSale` transaction, each line writes exactly one SALE movement (`<idempotencyKey>:<productId>:available:SALE`, available stock only, `-quantityBase`, the sale's trip and `createdAt`) after re-checking available stock against the rows already written in that transaction; a shortfall throws `CheckoutRefused(INSUFFICIENT_STOCK)`. Before commit the store re-reads the sale and its movements (`saleStockIssues(saleId)`) and throws on any disagreement, so a failure at any step (stock, outbox, invariant, SQLite) rolls back the receipt number, sale, lines, payment and every deduction together; the cart stays on screen for a retry with the same `saleId`. Room serialises write transactions, so two sales (or a sale and a damage) racing for the last stock sell it once and never go below zero.

SALE movements cannot be written any other way: `recordLocalMovement` refuses SALE, so no deduction exists without its saved sale. `RoomVanStore.saleStockIssues()` / `TruckStockLedger.saleStockIssues()` audit the whole partition and return `missing_deduction`, `wrong_deduction`, `unexpected_deduction`, `duplicate_product`, `no_lines` or `deduction_without_sale`; empty means sales and truck stock agree.

## Payment methods (VAN-012)

The office configures the methods in the bootstrap policy (`policy.paymentMethods`, van-v1; backend `VAN_PAYMENT_METHODS` in `convex/van/model.ts`): each has a `code`, `label`, `kind` (`cash` | `other` | `credit`), `referenceRequired` and `referenceLabel`. A policy without the list (an older cache or server) allows cash only. Assumed defaults until Sunpride confirms: Cash, Check (check number), GCash (reference number), Bank transfer (bank reference) and Credit (charge to account). One method per sale; split payments are not supported.

- **cash:** cash received ≥ total; change is recorded. Payment state `paid`.
- **other** (check, e-wallet, bank): the amount is exactly the total, no change. When the method needs a reference it is required, normalized (trimmed, single-spaced, upper case; letters, digits, space, `-`, `/`, `.`; 1–40) and must not already be on another payment of the same method on this phone. Payment state `awaiting_confirmation` (the office confirms the reference later).
- **credit:** only for a customer whose bootstrap row carries office terms (`customers[].credit = {termsDays, availableMinor}`, from the server's effective-dated `outletCreditTerms`; a local walk-in never), and only while the total fits the credit left = `availableMinor` minus credit sold on this phone whose sale the office has not acknowledged (parked sales always count, across re-bootstraps). Due date = service date + terms. Payment state `on_account`.

Payment state is stored apart from the sale's posting state: `sale.status` stays `saved` (posting) while `sale.paymentStatus` and `payment.status` carry `paid` / `awaiting_confirmation` / `on_account`; `payment` also stores the method code, amount, reference, cash handed over and due date. Room schema v2 adds these as nullable columns (`MIGRATION_1_2`, exported `2.json`); a v1 sale reads as cash/paid. The parked `sale.record` payload's `payment` is `{method, kind, status, amountMinor, tenderedMinor?, changeMinor?, reference?, dueDate?}`. `availableMinor` is the office limit today: open receivables are not on the server yet, so the handheld's own unacknowledged credit is the only deduction.

## Customer returns (VAN-019)

`com.sunpride.van.pos.ReturnRules.evaluate(ReturnRequest, ReturnContext)` is the pure return check shared by the screens and the store; `ReturnStore(store).commit(request)` (repository `recordReturn`) runs it again inside **one** Room transaction against the stored trip, customers, products and this phone's sales, then writes the return number (same per-trip receipt sequence as sales, `TransactionIds`), `customer_return`, `return_line`s, the RETURN stock movements and the `return.record` outbox operation, parked (`SALE_PARKED`) exactly like a sale because the van gateway has no return operation yet. Any failure rolls everything back, including the number; the same UUID-v4 `returnId` again returns the saved return (`replay = true`), a different request under it is refused. `SyncStatus.savedReturns` counts parked returns (`savedSales` now counts only sales).

Each line captures **product, unit** (`uomCode`: the product UOM, or a case/pack from `barcodeUnits` with a known base quantity — packs count whole packs only), **quantity** (integral base units; the operation also keeps `uomQuantity`), **reason**, **disposition**, **batch/lot** (normalized like payment references, 1–40) and optional **expiry** (ISO date). Header: the customer (route, unplanned or a local walk-in), an optional sale on this phone for the same customer, and an optional note (≤ 300). A linked return can never exceed what that sale sold, counting earlier returns against it.

**Disposition decides the stock movement** (truck stock changes only through these RETURN movements, one per product/status, deterministic IDs, ledger reason `customer_return`):

| Disposition                                     | Stock effect without approval | With approval pending            |
| ----------------------------------------------- | ----------------------------- | -------------------------------- |
| `resellable` — good stock, sell again           | + available                   | + damaged (held, never sellable) |
| `bad_stock` — bad order back to warehouse       | + damaged                     | + damaged                        |
| `disposed_at_outlet` — thrown away at the store | none                          | none                             |

**Approval** (`approval.required/reasons` on the operation; header `status` `awaiting_approval` or `recorded`): `disposed_at_outlet` (nothing comes back to check), a reason/disposition pair marked as needing approval (quality complaint; near-expiry resale), a return not linked to a sale on this phone (`not_linked_to_sale`), and walk-in customers (`walk_in`). Line-level reasons apply to that line; header-level ones (unlinked, walk-in) to every line.

**Assumed defaults (Sunpride has not given return rules; client refines later):** `ReturnPolicy.DEFAULT` reasons and their allowed dispositions — damaged {bad stock, disposed*}, expired {bad stock, disposed*} + batch, spoiled {bad stock, disposed*} + batch, near expiry {bad stock, resellable*} + batch, quality complaint {bad stock*} + batch, wrong item {resellable, bad stock}, not selling/overstock {resellable, bad stock} (* = needs approval). The policy is code-owned until the bootstrap carries an office-configured one (a later contract change). No money is computed: credit memos/refunds are the office's decision after approval.

No Room schema change: `return_line.stockStatus` holds the stock effect (`available`/`damaged`/`none`) and `reason` the reason code; unit, uom quantity, disposition, lot, expiry, approval, linked sale and note live in the frozen operation bytes (read back for replay). Office approval, release of held stock to available, return upload and printing a return slip are later lanes (they need the van gateway `return.record` operation and backend return rules).

## Offline ledger and identifiers

`TruckStockLedger(store, afterEnqueue)` exposes `projection()`, `canRemove(productId, qty)` and `recordDamage(productId, qty, reason, note = null)`. Damage transfers a positive quantity from available to damaged and inserts both immutable movements and the unchanged `truck.damage` outbox JSON in **one** Room transaction. Negative-stock policy defaults off; a sale/damage removal is checked again inside the transaction. A damaged-stock sale is not allowed.

The next return lane can call:

```kotlin
suspend fun TruckStockLedger.recordLocalMovement(
    type: MovementType,
    productId: String,
    stockStatus: StockStatus,
    quantityBase: Long,
    reason: String?,
    clientRequestId: String
): String
```

This hook supports RETURN, TRANSFER and ADJUSTMENT (SALE is written only by checkout, VAN-018), with deterministic movement IDs and exact replay/conflict checks. It can participate in a caller's Room transaction. It does not fabricate unsupported gateway operations. LOAD cannot be supplied through this hook, and DAMAGE must use its atomic damage/outbox command. Stock movement kinds are LOAD, SALE, RETURN, DAMAGE, TRANSFER, ADJUSTMENT; signed quantities apply separately to available/damaged. Arithmetic overflow refuses instead of wrapping.

Projection is current-trip server baseline plus every same-trip local movement without a settlement marker. A movement settles only when its operation has a durable ack **and** a replaced authoritative bootstrap has `serverTime > ack.serverTime`. Settlement inserts a marker; it never deletes or mutates the movement. Rejected damage remains conservatively deducted and visible for review; there is no automatic reversal or re-recording.

LOAD movements appear only when `load.confirm` returns a non-null posting movement ID, or a later bootstrap explicitly reports that an acknowledged discrepancy load is posted. A bare discrepancy ack is not stock. Immutable local load mappings allow acknowledgment replay even after a snapshot changes. A subsequent balance settles the load instead of adding it twice. Old-trip movements do not contaminate a new trip's projection.

`TransactionIds(db, scope).issue(tripId, tripNumber)` increments a per-trip persisted counter and inserts its issued pair inside one Room transaction:

`<tripNumber>-<deviceShortTag>-<sequence padded to at least four digits>`

The device tag is eight uppercase hexadecimal characters derived from the registered device ID. The sequence never wraps or truncates after 9999. The idempotency key is UUID-v4. Persist and reuse the pair for printing/reprinting, transport retries and later SAP reconciliation; never issue a new pair for a reprint. Fifty parallel real-SQLCipher issues are tested for uniqueness, then the database reopens and issues 0051.

## Sync and background delivery

`VanBootstrapCodec` validates the embedded frozen van-v1 JSON Schema before typed reads: unknown keys/enums, coercions, missing required nullable fields and bounded-array violations fail closed. Base quantities parse directly from decimal strings to Long. Frozen bootstrap/no-trip/push fixtures are read **in place** by JVM tests. Bootstrap replaces only scoped snapshot tables and the balance/meta in one transaction; outbox, ledger, sales and local-only customers survive.

`VanSyncClient` signs the exact UTF-8 body bytes. Each HTTP attempt obtains a fresh nonce, including the single JWT-401 retry, and derives its 13-digit timestamp from challenge `expiresAt - 30_000`. It hashes the body to lowercase SHA-256 hex and signs P1363 ECDSA over `POST|path|digest|nonce|timestamp`. All proof headers identify `VAN_ANDROID`. OkHttp handles gzip automatically; redirects/cookies are disabled.

`VanSync` has a process-wide subject/device mutex shared by foreground/worker instances. It recovers sending markers, bootstraps, sends ordered batches of at most 20 pending rows, then refreshes authoritative balances/state. Operation JSON bytes are concatenated verbatim from Room; retry never reparses/re-serializes payloads or changes IDs. Each ack is inserted before done in the same transaction. Rejected/conflict operations freeze for review; transport failure and cancellation return sending rows to pending. Missing, duplicate, mismatched or malformed result envelopes cannot create an ack. Whole-request invalid-request refusals freeze that batch; unauthorized delivery holds the partition.

Work is unique `van-sales-sync` (separate `-stub` chain), CONNECTED-constrained, APPEND_OR_REPLACE, exponential backoff starting at 30 seconds. Schedule only after committed enqueue. Foreground restoration/sync can schedule remaining work; workers deliberately do not append another worker on every restore/retry. OS delivery is best effort, not an exact latency guarantee. Sign-out/removal holds unsent work rather than deleting evidence; verified same-partition bootstrap can restore ordinary pending delivery, never unfreeze business-refused rows.

## DEBUG fixture mode and limits

Pass `Intent().putExtra(VanRepository.STUB_EXTRA, "ready")` to `create`, or pass `stubMode = "ready"` directly. Instrumentation can read its `VAN_STUB_BACKEND` argument and forward it to the factory/launch intent. Other supported scenarios are `unregistered` and `revoked`. Production ignores the selection; `FakeVanBackend` itself refuses construction outside DEBUG.

The fake serves the frozen bootstrap fixture (asserted equal to the source fixture by a JVM test), posts matching loads, keeps discrepancies awaiting approval, starts loaded trips, transfers damage balances, and replays exact original acks by request ID/payload digest. It uses fixture-only private preferences for simulated server state/replies, **separate encrypted stub database/session keys and a separate device key alias**, and survives relaunch. It never signs in to or changes the shared DEV deployment. Fake credentials/enrollment are not a real auth proof; fake posting is not office/SAP inventory integration.

Live van gateway functions are not deployed on shared DEV yet, so no live sign-in/device/bootstrap/push integration claim is made. Sale upload, office confirmation of check/e-wallet/bank payments, collections against credit sales, return/reconciliation command workflows, governed prices, office discrepancy approval UI, supervisor review/recovery and SAP handoff are later lanes. Printing/scanning and UI are separately owned.

## Verification

The only debug variant is `devDebug`. Use Android Studio JBR and the installed SDK:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew assembleDevDebug testDevDebugUnitTest lintDevDebug assembleDevDebugAndroidTest
~/.hermes/scripts/sunpride-pos-device-test.sh /Users/jc/cnc/.worktrees/sunpride-van-pos
```

The request's unflavored `lintDebug` name is ambiguous in this flavored skeleton; the explicit `lintDevDebug` gate is the real task. No Gradle configuration was changed to hide that naming mismatch. Device suites run only through the locking H10P wrapper, which retains the app and removes only its test APK. No emulator/connectedAndroidTest or Convex command is used.

JVM coverage includes auth/HTTP560/enrollment, frozen crypto, strict codec, integer ledger/settlement, identifiers, outbox rules, exact-byte replay, single-401 signing, gzip and diagnostics. Device coverage includes vault/key persistence, encrypted DB/WAL absence of a plaintext marker, wrong-key refusal, schema-v1 MigrationTestHelper validation, 50 concurrent/restarted IDs, damage transaction rollback, load authority, negative-sale/damage policy, scope isolation, evidence preservation, durable ack ordering/settlement and uncertain-acceptance replay against real SQLCipher Room.
