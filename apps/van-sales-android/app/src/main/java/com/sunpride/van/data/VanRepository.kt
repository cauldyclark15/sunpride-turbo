package com.sunpride.van.data

import android.content.Context
import android.content.Intent
import androidx.room.withTransaction
import com.sunpride.van.AppEnvironment
import com.sunpride.van.BuildConfig
import com.sunpride.van.auth.*
import com.sunpride.van.device.*
import com.sunpride.van.ledger.TruckStockLedger
import com.sunpride.van.storage.*
import com.sunpride.van.sync.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.Base64

/** Session status, never a token. Cached offline identity remains explicitly unverified. */
data class SessionState(val signedIn: Boolean = false, val offlinePending: Boolean = false)

@OptIn(ExperimentalCoroutinesApi::class)
class VanRepository private constructor(private val context: Context, private val environment: AppEnvironment, private val stubMode: String?, private val scheduleWork: Boolean = true) {
    private val lifetime = CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val authLock = Mutex()
    private val vault = if (stubMode != null) KeystoreSessionVault(context,"van_stub_session","sunpride-van-stub-session-aes-v1") else KeystoreSessionVault(context)
    private val auth = AuthClient(environment,vault)
    private val functions = ConvexFunctions(environment,auth)
    private val index = context.getSharedPreferences(if(stubMode != null) "van_stub_identity_index" else "van_identity_index",Context.MODE_PRIVATE)
    private val current = MutableStateFlow<RoomVanStore?>(null)
    private val session = MutableStateFlow(SessionState())
    private val enrollment = MutableStateFlow<EnrollmentState>(EnrollmentState.SignedOut)
    val sessionState: StateFlow<SessionState> = session.asStateFlow()
    val enrollmentState: StateFlow<EnrollmentState> = enrollment.asStateFlow()
    val currentTrip: Flow<Trip?> = current.flatMapLatest { it?.trip ?: flowOf(null) }
    val load: Flow<Load?> = current.flatMapLatest { it?.load ?: flowOf(null) }
    val loadLines: Flow<List<LoadLine>> = load.map { it?.lines ?: emptyList() }
    val seller: Flow<Seller?> = current.flatMapLatest { it?.seller ?: flowOf(null) }
    val policy: Flow<VanPolicy?> = current.flatMapLatest { it?.policy ?: flowOf(null) }
    val truckStock: Flow<List<TruckStock>> = current.flatMapLatest { it?.truckStock ?: flowOf(emptyList()) }
    val damageRecords: Flow<List<DamageRecord>> = current.flatMapLatest { it?.damageRecords ?: flowOf(emptyList()) }
    val products: Flow<List<Product>> = current.flatMapLatest { it?.products ?: flowOf(emptyList()) }
    val customers: Flow<List<Customer>> = current.flatMapLatest { it?.customers ?: flowOf(emptyList()) }
    val priceLines: Flow<List<PriceLine>> = current.flatMapLatest { it?.priceLines ?: flowOf(emptyList()) }
    val promotions: Flow<List<Promotion>> = current.flatMapLatest { it?.promotions ?: flowOf(emptyList()) }
    val syncStatus: Flow<SyncStatus> = current.flatMapLatest { it?.syncStatus ?: flowOf(SyncStatus()) }
    /** VAN-022: the current trip's cash is counted on this phone. */
    val cashCounted: Flow<Boolean> = current.flatMapLatest { it?.cashCounted ?: flowOf(false) }
    /** VAN-023: the current trip's physical stock is counted on this phone. */
    val stockCounted: Flow<Boolean> = current.flatMapLatest { it?.stockCounted ?: flowOf(false) }
    /** VAN-024: the current trip is closed on this phone. */
    val tripClosed: Flow<Boolean> = current.flatMapLatest { it?.tripClosed ?: flowOf(false) }
    /** SP-0137: the signed-in scope (person + registered phone) location sharing is recorded under. */
    val storeScope: Flow<StoreScope?> = current.map { it?.scope }
    /** SP-0137: live-location pings waiting on this phone for upload. */
    val pendingPings: Flow<Int> = current.flatMapLatest { it?.locations?.pendingCount ?: flowOf(0) }
    private var database: VanDatabase? = null
    private var signer: DeviceSigner? = null
    private var gateway: VanGateway? = null
    private fun sessionKey(): String? = vault.readSession()?.let { hex(sha256(it.toByteArray(Charsets.UTF_8))) }
    private fun attach(scope: StoreScope) {
        val db = database ?: (if(stubMode != null) EncryptedVanDatabase.openStub(context) else EncryptedVanDatabase.open(context)).also { database = it }
        if (current.value?.scope != scope) current.value = RoomVanStore(db,scope,evidence=photoFiles(scope))
    }
    private fun photoFiles(scope: StoreScope) = com.sunpride.van.evidence.DamagePhotoFiles(
        if (stubMode != null) java.io.File(context.noBackupFilesDir,"van-stub") else context.noBackupFilesDir,scope)
    suspend fun saveDamagePhoto(capture: com.sunpride.van.evidence.DamageCapture): com.sunpride.van.evidence.DamagePhoto = withContext(Dispatchers.IO) {
        val st = store(); val policy = checkNotNull(st.policy.first())
        val bytes = com.sunpride.van.evidence.DamagePhotoEncoder.compress(capture,policy.damagePolicy?.photoMaxBytes ?: 90_000)
        check(st === current.value && st.canSync())
        photoFiles(st.scope).save(bytes,policy.damagePolicy?.photoMaxBytes ?: 90_000)
    }
    suspend fun discardDamagePhoto(sha: String) = withContext(Dispatchers.IO) {
        val st = store()
        st.db.withTransaction {
            if (st === current.value && st.canSync() && st.db.rows().outboxRows(st.scope.fullAuthSubject,st.scope.deviceId).none { damagePhotoSha(it) == sha }) photoFiles(st.scope).delete(sha)
        }
    }
    private fun loadSigner(): DeviceSigner = signer ?: KeystoreDeviceKey.loadOrCreate(context,if(stubMode != null) "sunpride-van-stub-device-p256-v1" else KeystoreDeviceKey.DEFAULT_ALIAS).also { signer = it }
    private suspend fun enroll(): EnrollmentState {
        if (stubMode != null) {
            val state = when(stubMode) { "unregistered" -> EnrollmentState.Unregistered; "revoked" -> EnrollmentState.Removed; else -> EnrollmentState.Ready("stub-van-device") }
            enrollment.value = state
            if (state is EnrollmentState.Ready) { vault.deviceId = state.deviceId; attach(StoreScope("https://fixture.invalid|stub-van-seller",state.deviceId)); session.value = SessionState(true); gateway = FakeVanBackend(context=context) }
            else { current.value?.hold(); current.value = null }
            return state
        }
        val state = withContext(Dispatchers.IO) { Enrollment(ConvexDeviceApi(functions),loadSigner(),vault).refresh() }
        enrollment.value = state
        if (state is EnrollmentState.Ready) {
            val token = withContext(Dispatchers.IO) { auth.convexToken() }
            val claims = JSONObject(String(Base64.getUrlDecoder().decode(token.split('.')[1]),Charsets.UTF_8))
            val issuer = claims.getString("iss"); val subject = claims.getString("sub")
            check(issuer.startsWith("https://") && subject.isNotBlank())
            val full = "$issuer|$subject"; val key = checkNotNull(sessionKey())
            check(index.edit().putString("$key.subject",full).putString("$key.device",state.deviceId).commit())
            attach(StoreScope(full,state.deviceId)); session.value = SessionState(true)
            gateway = VanSyncClient(LiveVanTransport(environment,auth,functions),loadSigner(),state.deviceId)
        } else { current.value?.hold(); current.value = null }
        return state
    }
    suspend fun restoreSession(): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            if(stubMode != null && vault.readSession() == null) vault.saveSession("debug-fixture-session")
            val key = sessionKey()
            if (key == null) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut; return@withContext }
            session.value = SessionState(true,true)
            val subject = index.getString("$key.subject",null); val device = index.getString("$key.device",null)
            if (subject != null && device != null && vault.deviceId == device) {
                attach(StoreScope(subject,device))
                gateway = VanSyncClient(LiveVanTransport(environment,auth,functions),loadSigner(),device)
            }
            try { enroll() } catch (e: AuthFailure) {
                if (e.kind != AuthFailure.Kind.OFFLINE) { current.value?.hold(); current.value = null; if (!auth.isSignedIn) session.value = SessionState(); throw e }
            }
            current.value?.resetSending()
            if (current.value?.pending()?.isNotEmpty() == true) schedule()
        }
    }
    suspend fun signIn(email: String, password: String): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            current.value?.hold(); current.value = null; gateway = null
            if (stubMode == null) auth.signIn(email,password) else {
                // Debug fixture only: reproduce the server's sign-in refusals without a network.
                when (password) {
                    STUB_WRONG_PASSWORD -> throw AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)
                    STUB_OFFLINE_PASSWORD -> throw AuthFailure(AuthFailure.Kind.OFFLINE)
                }
                vault.saveSession("debug-fixture-session")
            }
            session.value = SessionState(true,true); enroll(); Unit
        }
    }
    suspend fun refreshEnrollment(): EnrollmentState = authLock.withLock { withContext(Dispatchers.IO) { enroll() } }
    suspend fun signOut(): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            try { current.value?.hold() } finally {
                current.value = null; gateway = null; enrollment.value = EnrollmentState.SignedOut; session.value = SessionState()
                if(stubMode != null) vault.wipe() else auth.signOut()
            }; Unit
        }
    }
    private fun store(): RoomVanStore { check(session.value.signedIn && vault.readSession() != null); return checkNotNull(current.value) { "Sign in and register this phone" } }
    private fun schedule() { if (scheduleWork) runCatching { SyncWork.enqueue(context,stubMode != null) }.onFailure { com.sunpride.van.diagnostics.SafeLog.event(context,"sync_retry") } }
    suspend fun startTrip(vehicleConfirmed: Boolean, routeConfirmed: Boolean, driverName: String? = null, helperName: String? = null, odometerKm: Double? = null, note: String? = null): String {
        val id = store().startTrip(vehicleConfirmed,routeConfirmed,driverName,helperName,odometerKm,note); schedule(); return id
    }
    suspend fun confirmLoad(lines: List<LoadActual>): String { val id = store().confirmLoad(lines); schedule(); return id }
    suspend fun recordDamage(productId: String, qty: Long, reason: String, note: String? = null, photoSha256: String? = null): String = TruckStockLedger(store(),::schedule).recordDamage(productId,qty,reason,note,photoSha256)
    suspend fun canRemove(productId: String, qty: Long): Boolean = store().canRemove(productId,qty)
    suspend fun addWalkInCustomer(name: String, reason: String): Customer = store().addWalkInCustomer(name,reason)
    suspend fun issueTransactionId(): com.sunpride.van.ids.TransactionIdentity {
        val st = store(); val trip = checkNotNull(st.db.rows().trip(st.scope.fullAuthSubject,st.scope.deviceId))
        return com.sunpride.van.ids.TransactionIds(st.db,st.scope).issue(trip.tripId,trip.tripNumber)
    }
    /**
     * VAN-011: validate and save a sale on this phone in one encrypted transaction (see `RoomVanStore.commitSale`).
     * Throws [com.sunpride.van.pos.CheckoutRefused] with typed reasons; never needs the network. No upload is
     * scheduled: the van gateway has no sale operation yet, so the sale's outbox row stays parked.
     */
    suspend fun completeSale(request: com.sunpride.van.pos.CheckoutRequest, expectedTotalMinor: Long): SaleReceipt =
        withContext(Dispatchers.IO) { store().commitSale(request,expectedTotalMinor) }
    suspend fun voidSale(saleId: String, reason: String?, note: String?, code: String?): com.sunpride.van.pos.SaleVoidResult =
        withContext(Dispatchers.IO) { store().voidSale(saleId,reason,note,code) }
    /** VAN-012: credit sold here per customer and references already used, so Checkout warns before the store refuses. */
    suspend fun paymentFacts(): com.sunpride.van.storage.PaymentFacts = withContext(Dispatchers.IO) { store().paymentFacts() }
    /**
     * VAN-019: validate and save a customer return on this phone in one encrypted transaction (see `ReturnStore.commit`).
     * Throws [com.sunpride.van.pos.ReturnRefused] with typed reasons; never needs the network. Parked like a sale.
     */
    suspend fun recordReturn(request: com.sunpride.van.pos.ReturnRequest): com.sunpride.van.pos.ReturnReceipt =
        withContext(Dispatchers.IO) { ReturnStore(store()).commit(request) }
    /** VAN-019: sales saved here (to link a return to its receipt) and what was already returned against each. */
    suspend fun returnContext(): com.sunpride.van.pos.ReturnContext = withContext(Dispatchers.IO) { ReturnStore(store()).context() }
    /**
     * VAN-017: print (or, when [explicit] with a reason, reprint) a sale saved on this phone. The attempt is recorded
     * in the scoped encrypted store before the printer is called; nothing about the sale itself changes.
     */
    suspend fun printReceipt(printer: com.sunpride.van.printing.ReceiptPrinter, saleId: String, explicit: Boolean, reasonCode: String? = null): com.sunpride.van.printing.PrintJobResult =
        withContext(Dispatchers.IO) { val st = store(); com.sunpride.van.printing.ReceiptPrintFlow(printer,RoomReceiptPrintLog(st.db,st.scope)).print(saleId,explicit,reasonCode) }
    /** VAN-022: expected cash from this trip's saved sales and payments, and the saved count once there is one. */
    suspend fun cashSummary(): CashSummary? = withContext(Dispatchers.IO) { CashReconciliationStore(store()).summary() }
    /**
     * VAN-022: save the end-of-trip cash count in one encrypted transaction (see `CashReconciliationStore.commit`).
     * Throws [com.sunpride.van.pos.CashRefused]; never needs the network. Parked like a sale; no upload is scheduled.
     */
    suspend fun countCash(request: com.sunpride.van.pos.CashCountRequest): com.sunpride.van.pos.CashCountResult =
        withContext(Dispatchers.IO) { CashReconciliationStore(store()).commit(request) }
    /** VAN-023: expected truck stock and the saved physical count. */
    suspend fun stockSummary(): com.sunpride.van.pos.StockSummary? = withContext(Dispatchers.IO) { StockReconciliationStore(store()).summary() }
    /** VAN-023: save the physical stock count; it remains parked until the gateway supports it. */
    suspend fun countStock(request: com.sunpride.van.pos.StockCountRequest): com.sunpride.van.pos.StockCountResult =
        withContext(Dispatchers.IO) { StockReconciliationStore(store()).commit(request) }
    /** VAN-024: what must be done before closing the trip, and the saved close. */
    suspend fun closeSummary(): com.sunpride.van.pos.TripCloseSummary? = withContext(Dispatchers.IO) { TripCloseStore(store()).summary() }
    /** VAN-024: close the trip on this phone; it remains parked until the gateway supports it. */
    suspend fun closeTrip(request: com.sunpride.van.pos.TripCloseRequest): com.sunpride.van.pos.TripCloseResult =
        withContext(Dispatchers.IO) { TripCloseStore(store()).commit(request) }
    /** VAN-017: sales saved on the current trip with their print history, newest first. */
    suspend fun savedSales(): List<SavedSale> = withContext(Dispatchers.IO) { val st = store(); RoomReceiptPrintLog(st.db,st.scope).savedSales() }
    /** DEBUG practice data only: the fixture store, so device tests can seed the (still empty) price list. */
    internal fun fixtureStore(): RoomVanStore { check(BuildConfig.DEBUG && stubMode != null); return store() }
    suspend fun syncNow(): Unit = authLock.withLock {
        val st = store()
        try { VanSync(st,checkNotNull(gateway),evidence=st.evidence).syncNow(); session.value = SessionState(true) }
        catch (e: AuthFailure) {
            if (!auth.isSignedIn) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut; current.value = null; gateway = null }
            throw e
        }
        finally { if (st.pending().isNotEmpty()) schedule() }
    }
    /** Scope owned by the repository; never construct this from a UI-selected identity. */
    fun close() { lifetime.cancel(); current.value = null; database?.close(); database = null }
    companion object {
        const val STUB_EXTRA = "VAN_STUB_BACKEND"
        internal const val STUB_WRONG_PASSWORD = "fixture-wrong-password"
        internal const val STUB_OFFLINE_PASSWORD = "fixture-offline"
        internal fun forWorker(context: Context, stub: Boolean): VanRepository = VanRepository(context.applicationContext,
            AppEnvironment(BuildConfig.CONVEX_SITE_URL,BuildConfig.CONVEX_URL),if (stub && BuildConfig.DEBUG) "ready" else null,scheduleWork=false)
        fun create(context: Context, intent: Intent? = null, stubMode: String? = null,
            environment: AppEnvironment = AppEnvironment(BuildConfig.CONVEX_SITE_URL,BuildConfig.CONVEX_URL)): VanRepository {
            val mode = (stubMode ?: intent?.getStringExtra(STUB_EXTRA))?.takeIf { BuildConfig.DEBUG && it in setOf("ready","unregistered","revoked") }
            return VanRepository(context.applicationContext,environment,mode)
        }
    }
}
