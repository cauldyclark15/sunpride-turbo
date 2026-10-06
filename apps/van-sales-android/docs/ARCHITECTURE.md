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

`TruckStock(productId, availableBase: Long, damagedBase: Long)` is a local projection. `Product` has code/name/UOM/scale and all bootstrap barcodes, with `displayQuantity(base: Long): String`. Quantities stay integral in storage and divide by `quantityScale` only for display; prices never derive from stock or product data.

`Customer` exposes outlet ID, code/name/address, sequence, `source` (`route`, `unplanned`, `walk_in`), nullable reason and `localOnly`. Filter this single scoped flow for route/unplanned/walk-in lists. Local walk-ins require a nonblank name and reason, require `walkInAllowed`, survive snapshot replacement, and are never silently uploaded as real outlet IDs.

`SyncStatus` has `queued`, `sending`, `review`, `held`, nullable `lastSyncTime`, and `health`. Counts and last successful sync come from Room. Review includes both rejected and conflicting operations. A successful HTTP response alone does not mean all local work was accepted.

## Auth and storage security

Sign-in sends JSON to `/api/auth/sign-in/email`, omits Origin and cookies, prefers `set-auth-token` and otherwise validates the top-level JSON session token. JWT exchange uses the session bearer at `/api/auth/convex/token`; the JWT remains in memory and refreshes before expiry. Convex `/api/query|mutation` responses are decoded as envelopes, including HTTP 560 function errors; a JWT 401 gets one refresh/retry. Errors never display raw server messages.

Session AES-256-GCM and database passphrase AES-256-GCM use separate Keystore aliases. The SQLCipher passphrase is ASCII-hex encoding of 32 random bytes; only its wrapped IV/ciphertext is persisted. SQLCipher 4.12.0 is explicitly loaded with `System.loadLibrary("sqlcipher")`, and every production open uses `SupportOpenHelperFactory`. Missing/corrupt key material refuses access. There is no plaintext fallback, destructive migration, or sign-out database-key wipe.

All 19 v1 tables are partitioned by `StoreScope(fullAuthSubject, deviceId)`. The full auth identity is `issuer|subject`, never a stripped subject, profile display name or arbitrary UI selection. The repository saves the identity index under a digest of the encrypted session token, so another session cannot select an old account's partition. Caller-created Room scopes are for core tests/authorized integration only; the UI uses the repository.

Schema v1 is exported at `app/schemas/com.sunpride.van.storage.VanDatabase/1.json`. Snapshot tables are `trip`, `load_line`, `product`, `customer` and `truck_stock_baseline`. Work/evidence tables are `stock_movement`, append-only `movement_settlement`, `outbox`, `ack`, `sync_meta`, `sequence_counter`, and immutable `transaction_id`. Future financial workflow tables are `sale`, `sale_line`, `payment`, `customer_return`, `return_line`, `reconciliation` and `price_list_line`.

`com.sunpride.van.pos.ProductSearch(products, stock, prices, now)` is the pure POS search index (VAN-008): `search(query, limit = 60)` returns ranked `PosProductHit(product, availableBase, price, match)` and `byBarcode(code)` is the exact scan lookup. `PriceResolver` returns a `PosPrice` only when exactly one effective, non-negative `price_list_line` row exists for the product's own UOM at `now`; conflicting lists, other UOMs, future/expired rows yield null (**Priced by the office**). `VanRepository.priceLines` exposes the scoped `price_list_line` table as `PriceLine` (a read-only DAO flow; no schema change).

Sale/payment prices and totals are nullable, not zero: UI wording is **Priced by the office**. Payments currently model cash only. The price-list table remains empty until the governed feed exists. These are schema provisions, not a completed sale/payment/return/reconciliation submission workflow.

## Offline ledger and identifiers

`TruckStockLedger(store, afterEnqueue)` exposes `projection()`, `canRemove(productId, qty)` and `recordDamage(productId, qty, reason, note = null)`. Damage transfers a positive quantity from available to damaged and inserts both immutable movements and the unchanged `truck.damage` outbox JSON in **one** Room transaction. Negative-stock policy defaults off; a sale/damage removal is checked again inside the transaction. A damaged-stock sale is not allowed.

The next sale/return lane can call:

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

This hook supports SALE, RETURN, TRANSFER and ADJUSTMENT, with deterministic movement IDs and exact replay/conflict checks. It can participate in a caller's Room transaction. It does not fabricate unsupported gateway operations. LOAD cannot be supplied through this hook, and DAMAGE must use its atomic damage/outbox command. Stock movement kinds are LOAD, SALE, RETURN, DAMAGE, TRANSFER, ADJUSTMENT; signed quantities apply separately to available/damaged. Arithmetic overflow refuses instead of wrapping.

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

Live van gateway functions are not deployed on shared DEV yet, so no live sign-in/device/bootstrap/push integration claim is made. Sale/payment/return/reconciliation command workflows, governed prices, office discrepancy approval UI, supervisor review/recovery and SAP handoff are later lanes. Printing/scanning and UI are separately owned.

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
