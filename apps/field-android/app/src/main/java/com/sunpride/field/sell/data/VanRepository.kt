package com.sunpride.field.sell.data

import android.content.Context
import androidx.room.withTransaction
import com.sunpride.field.BuildConfig
import com.sunpride.field.sell.auth.*
import com.sunpride.field.device.*
import com.sunpride.field.sell.ledger.TruckStockLedger
import com.sunpride.field.sell.storage.*
import com.sunpride.field.sell.sync.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.Base64

/** Session status, never a token. Cached offline identity remains explicitly unverified. */
data class SessionState(val signedIn: Boolean = false, val offlinePending: Boolean = false)

/**
 * SP-0192: the Van app's selling repository inside the Field app. Sign-in, registration and the device key are the Field
 * app's ([SellAccess]); the selling store lives in the Field app's encrypted database (`sell_` tables). Created only when
 * the office has switched Selling on for this person, so a non-seller never opens, downloads or schedules anything here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VanRepository private constructor(private val context: Context, private val access: SellAccess, private val stubMode: String?, private val scheduleWork: Boolean = true) {
    private val lifetime = CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val authLock = Mutex()
    private val api = NativeApi(access)
    private var identity: NativeIdentity? = null
    private val index = context.getSharedPreferences(if(stubMode != null) "sell_stub_identity_index" else "sell_identity_index",Context.MODE_PRIVATE)
    private val current = MutableStateFlow<RoomVanStore?>(null)
    // A cached trip is not a grant. Expiry also withdraws already-visible reference data without a network.
    private val pulse: Flow<Long> = flow { while (currentCoroutineContext().isActive) { emit(System.currentTimeMillis()); delay(1_000) } }
    private val visible: Flow<RoomVanStore?> = current.flatMapLatest { st ->
        if (st == null || !st.scope.fullAuthSubject.startsWith("v2|")) flowOf(st)
        else combine(st.db.sellRows().observeSyncMeta(st.scope.fullAuthSubject,st.scope.deviceId),pulse) { metas,now ->
            if (metas.singleOrNull()?.authorizes(now) == true && st.canSync()) st else null
        }
    }.distinctUntilChanged()
    private val session = MutableStateFlow(SessionState())
    private val enrollment = MutableStateFlow<EnrollmentState>(EnrollmentState.SignedOut)
    val sessionState: StateFlow<SessionState> = session.asStateFlow()
    val enrollmentState: StateFlow<EnrollmentState> = enrollment.asStateFlow()
    /** IP-HH2: the seller's count of the clerk's load (`load.accept`). */
    suspend fun acceptLoad(info:com.sunpride.field.sell.vanday.VanDayInfo,counts:Map<String,com.sunpride.field.sell.vanday.AcceptCount>,note:String?):String = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.VanDayStore(store()).acceptLoad(info,counts,note).also {schedule()} }
    suspend fun acceptWaiting(tripId:String):Boolean = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.VanDayStore(store()).acceptWaiting(tripId) }
    /** IP-HH2: a crew member takes over the phone with their PIN (`crew.switch`); false = wrong PIN. No sign-out, no change to the registration. */
    suspend fun switchCrew(info:com.sunpride.field.sell.vanday.VanDayInfo,member:com.sunpride.field.sell.vanday.CrewMember,pin:String):Boolean = withContext(Dispatchers.Default) {
        val salt=member.salt;val hash=member.hash
        if(salt==null||hash==null||!member.hasPin) return@withContext false
        val key=com.sunpride.field.sell.security.PinProofs.derive(pin,salt)
        try {
            if(!com.sunpride.field.sell.security.PinProofs.matches(key,hash)) return@withContext false
            withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.VanDayStore(store()).switchCrew(info,member,key); schedule() }
            true
        } finally { key.fill(0) }
    }
    /** IP-HH2: the server's check of a discount claim (nothing is written). Any failure just means the phone's own figures stand; it never holds the account. */
    suspend fun claimPreview(body:JSONObject):JSONObject = withContext(Dispatchers.IO) {
        val st=store();check(st.canSync()){"Not signed in to the office"}
        api.request("/api/v1/fiscal/discount-claims/preview",body)
    }
    val currentTrip: Flow<Trip?> = visible.flatMapLatest { it?.trip ?: flowOf(null) }.offMain()
    val load: Flow<Load?> = visible.flatMapLatest { it?.load ?: flowOf(null) }.offMain()
    val loadLines: Flow<List<LoadLine>> = load.map { it?.lines ?: emptyList() }.offMain()
    val seller: Flow<Seller?> = visible.flatMapLatest { it?.seller ?: flowOf(null) }.offMain()
    val policy: Flow<VanPolicy?> = visible.flatMapLatest { it?.policy ?: flowOf(null) }.offMain()
    val truckStock: Flow<List<TruckStock>> = visible.flatMapLatest { it?.truckStock ?: flowOf(emptyList()) }.offMain()
    val heldStock: Flow<Map<String,Long>> = visible.flatMapLatest { it?.heldStock ?: flowOf(emptyMap()) }.offMain()
    val damageRecords: Flow<List<DamageRecord>> = visible.flatMapLatest { it?.damageRecords ?: flowOf(emptyList()) }.offMain()
    val products: Flow<List<Product>> = visible.flatMapLatest { it?.products ?: flowOf(emptyList()) }.offMain()
    fun catalogueImage(image:com.sunpride.catalogue.CatalogueImage):ByteArray? = if(stubMode!=null)null else api.image(image)
    init { if(stubMode==null) lifetime.launch { products.collectLatest { rows ->
        val job=currentCoroutineContext()[Job]
        runCatching { com.sunpride.catalogue.warmCatalogueImages(context,rows.mapNotNull{it.catalogue},::catalogueImage){job?.isActive!=false} }
    } } }
    val customers: Flow<List<Customer>> = visible.flatMapLatest { it?.customers ?: flowOf(emptyList()) }.offMain()
    val priceLines: Flow<List<PriceLine>> = visible.flatMapLatest { it?.priceLines ?: flowOf(emptyList()) }.offMain()
    val promotions: Flow<List<Promotion>> = visible.flatMapLatest { it?.promotions ?: flowOf(emptyList()) }.offMain()
    /** Signed in with a store whose office grant is held or expired: reference data is hidden, saved work is kept. */
    val onHold: Flow<Boolean> = combine(current,visible) { all,shown -> all != null && shown == null }.offMain()
    val syncStatus: Flow<SyncStatus> = current.flatMapLatest { it?.syncStatus ?: flowOf(SyncStatus()) }.offMain()
    /** VAN-022: the current trip's cash is counted on this phone. */
    val cashCounted: Flow<Boolean> = current.flatMapLatest { it?.cashCounted ?: flowOf(false) }.offMain()
    /** VAN-023: the current trip's physical stock is counted on this phone. */
    val stockCounted: Flow<Boolean> = current.flatMapLatest { it?.stockCounted ?: flowOf(false) }.offMain()
    /** VAN-024: the current trip is closed on this phone. */
    val tripClosed: Flow<Boolean> = current.flatMapLatest { it?.tripClosed ?: flowOf(false) }.offMain()
    /** VAN-083: where the trip close stands at the office. */
    val closeOffice: Flow<com.sunpride.field.sell.pos.CloseOffice> = current.flatMapLatest { it?.closeOffice ?: flowOf(com.sunpride.field.sell.pos.CloseOffice.NOT_CLOSED) }.offMain()
    /** SP-0137: the signed-in scope (person + registered phone) location sharing is recorded under. */
    val storeScope: Flow<StoreScope?> = current.map { it?.scope }.offMain()
    /** SP-0137: live-location pings waiting on this phone for upload. */
    val pendingPings: Flow<Int> = current.flatMapLatest { it?.locations?.pendingCount ?: flowOf(0) }.offMain()
    private var gateway: VanGateway? = null
    private fun sessionKey(): String? = if (stubMode != null) "stub-session" else access.sessionKey()
    private fun attach(scope: StoreScope) {
        val db = com.sunpride.field.storage.EncryptedFieldDatabase.shared(context)
        if (current.value?.scope != scope) current.value = RoomVanStore(db,scope,evidence=photoFiles(scope))
    }
    private fun photoFiles(scope: StoreScope) = com.sunpride.field.sell.evidence.DamagePhotoFiles(
        if (stubMode != null) java.io.File(context.noBackupFilesDir,"sell-stub") else java.io.File(context.noBackupFilesDir,"sell"),scope)
    suspend fun saveDamagePhoto(capture: com.sunpride.field.sell.evidence.DamageCapture): com.sunpride.field.sell.evidence.DamagePhoto = withContext(Dispatchers.IO) { com.sunpride.integrity.RemoteErasure.recordingLock.withLock {
        val st = store(); val policy = checkNotNull(st.policy.first())
        val maxBytes=policy.damagePolicy?.photoMaxBytes ?: 90_000
        // Explicit DEBUG practice fixture only; production never substitutes invented coordinates.
        val location = if (BuildConfig.DEBUG && stubMode != null) android.location.Location("SAMPLE practice fixture").apply {
            latitude=10.33; longitude=123.94; accuracy=5f; time=System.currentTimeMillis()
        } else com.sunpride.integrity.DeviceIntegrity.captureLocation(context, benchTestProvider = com.sunpride.field.BuildConfig.E2E_MOCK_LOCATION)
        val person=checkNotNull(st.seller.first())
        val profile=if (BuildConfig.DEBUG && stubMode != null) "SAMPLE practice profile" else checkNotNull(identity).profileId
        val facts=com.sunpride.integrity.ExecutionWatermark.Facts(location.latitude,location.longitude,location.accuracy.toDouble(),
            System.currentTimeMillis(),person.name,profile,"Truck damage · outlet not applicable","not_applicable")
        var bytes:ByteArray?=null
        for((dimension,quality) in listOf(1600 to 85,1200 to 70,900 to 55,640 to 40)) {
            val candidate=com.sunpride.integrity.ExecutionWatermark.burn(capture.jpeg,facts,capture.rotationDegrees,quality,dimension)
            if(candidate.size<=maxBytes) {bytes=candidate;break}
        }
        val marked=checkNotNull(bytes) { "Photo exceeds the configured limit" }
        check(st === current.value && st.canSync())
        photoFiles(st.scope).save(marked,maxBytes)
    } }
    suspend fun discardDamagePhoto(sha: String) = withContext(Dispatchers.IO) {
        val st = store()
        st.db.withTransaction {
            if (st === current.value && st.canSync() && st.db.sellRows().outboxRows(st.scope.fullAuthSubject,st.scope.deviceId).none { damagePhotoSha(it) == sha }) photoFiles(st.scope).delete(sha)
        }
    }
    /** F-113 photo bytes travel atomically in the encrypted return operation (32 KB maximum). */
    suspend fun prepareReturnPhoto(capture: com.sunpride.field.sell.evidence.DamageCapture): String = withContext(Dispatchers.IO) {
        val bytes=com.sunpride.field.sell.evidence.DamagePhotoEncoder.compress(capture,32_000)
        JSONObject().put("sha256",hex(sha256(bytes))).put("base64",Base64.getEncoder().encodeToString(bytes)).toString()
    }
    private fun loadSigner(): DeviceSigner = access.signer()
    private suspend fun enroll(): EnrollmentState {
        if (stubMode != null) {
            val state = EnrollmentState.Ready("stub-van-device")
            enrollment.value = state
            attach(StoreScope("https://fixture.invalid|stub-van-seller",state.deviceId)); session.value = SessionState(true); gateway = FakeVanBackend(context=context)
            return state
        }
        val device = access.deviceId()
        if (!access.isSignedIn || device == null) { current.value?.hold(); current.value = null; enrollment.value = EnrollmentState.SignedOut; return EnrollmentState.SignedOut }
        val (id, registered) = withContext(Dispatchers.IO) { api.identity() }
        if (registered != device) { current.value?.hold(); current.value = null; enrollment.value = EnrollmentState.Removed; return EnrollmentState.Removed }
        val state = EnrollmentState.Ready(device)
        enrollment.value = state
        identity = id
        val full = id.partitionSubject; val key = checkNotNull(sessionKey())
        if (current.value?.scope != StoreScope(full,device)) current.value?.hold()
        check(index.edit().putString("$key.subject",full).putString("$key.device",device)
            .putString("$key.identity",JSONObject().put("subject",id.subject).put("profileId",id.profileId)
                .put("scopeId",id.scopeId).put("fingerprint",id.fingerprint).put("epoch",id.epoch).toString()).commit())
        attach(StoreScope(full,device)); session.value = SessionState(true)
        gateway = VanSyncClient(LiveVanTransport(access,api),loadSigner(),device,id)
        return state
    }
    /** VAN-085: the last [restoreSession] could not reach the office and opened the day saved on this phone. */
    @Volatile var restoredOffline: Boolean = false
        private set
    /** Opens the day saved on this phone at once, then checks with the office (offline keeps the saved day, read only to sync). */
    suspend fun restoreSession(): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            val key = sessionKey()
            if (key == null || stubMode == null && !access.isSignedIn) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut; return@withContext }
            session.value = SessionState(true,true)
            val subject = index.getString("$key.subject",null); val device = index.getString("$key.device",null)
            if (stubMode == null && subject != null && device != null && access.deviceId() == device) {
                attach(StoreScope(subject,device))
                index.getString("$key.identity",null)?.let { raw ->
                    val o = JSONObject(raw)
                    val saved = NativeIdentity(o.getString("subject"),o.getString("profileId"),o.getString("scopeId"),o.getString("fingerprint"),o.getString("epoch"))
                    check(saved.partitionSubject == subject)
                    identity = saved
                    gateway = VanSyncClient(LiveVanTransport(access,api),loadSigner(),device,saved)
                }
            }
            restoredOffline = false
            try { enroll() } catch (e: AuthFailure) {
                if (e.kind == AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED) { current.value?.resetSending(); return@withContext }
                if (e.kind !in setOf(AuthFailure.Kind.OFFLINE,AuthFailure.Kind.PAUSED)) { current.value?.hold(); current.value = null; if (!access.isSignedIn) session.value = SessionState(); throw e }
                // Previously verified finite lease, not a new grant. Never unhold retained evidence offline.
                if (current.value?.canSync() == true && gateway != null && device != null) enrollment.value = EnrollmentState.Ready(device)
                if (e.kind == AuthFailure.Kind.PAUSED) { runCatching { current.value?.setHealth(com.sunpride.field.sell.sync.SyncHealth.PAUSED_HEALTH, null) }; throw e }
                restoredOffline = true
            }
            current.value?.resetSending()
            if (current.value?.pending()?.isNotEmpty() == true) schedule()
        }
    }
    suspend fun refreshEnrollment(): EnrollmentState = authLock.withLock { withContext(Dispatchers.IO) { enroll() } }
    /**
     * Selling was switched off, or the person signed out: the selling store is held (nothing more is recorded or sent; unsent
     * work stays on this phone for the office) and the Sell area lets go of it.
     */
    suspend fun detach(): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            try { current.value?.hold() } finally { current.value = null; gateway = null; identity = null; enrollment.value = EnrollmentState.SignedOut; session.value = SessionState() }
        }
    }
    private fun store(): RoomVanStore { check(session.value.signedIn && (stubMode != null || access.isSignedIn)); return checkNotNull(current.value) { "Sign in and register this phone" } }
    private fun schedule() { if (scheduleWork) runCatching { SyncWork.enqueue(context,stubMode != null) }.onFailure { com.sunpride.field.sell.diagnostics.SafeLog.event(context,"sync_retry") } }
    suspend fun startTrip(vehicleConfirmed: Boolean, routeConfirmed: Boolean, driverName: String? = null, helperName: String? = null, odometerKm: Double? = null, note: String? = null, openingFloatCentavos: Long = 0L): String {
        val id = store().startTrip(vehicleConfirmed,routeConfirmed,driverName,helperName,odometerKm,note,openingFloatCentavos); schedule(); return id
    }
    suspend fun confirmLoad(lines: List<LoadActual>): String { val id = store().confirmLoad(lines); schedule(); return id }
    /** F-114/F-115/F-116/F-121 use the same scoped store and background sync as sales. */
    suspend fun routeSnapshot() = withContext(Dispatchers.IO) { RouteOpsStore(store()).snapshot() }
    suspend fun routeScorecard() = withContext(Dispatchers.IO) { DailyScorecardStore(store()).snapshot() }
    suspend fun routeContainerPosition() = withContext(Dispatchers.IO) { RouteOpsStore(store()).containerPosition() }
    suspend fun recordStop(outletId: String,phase: String) = withContext(Dispatchers.IO) { RouteOpsStore(store()).stop(outletId,phase).also {schedule()} }
    suspend fun routeObservations(): List<JSONObject> = withContext(Dispatchers.IO) { RouteOpsStore(store()).observations() }
    suspend fun batchPositions(): List<com.sunpride.field.sell.ledger.BatchPosition> = withContext(Dispatchers.IO) { com.sunpride.field.sell.ledger.BatchLedger(store()).positions() }
    suspend fun recordTemperature(deciC: Int,checkpoint: String,outletId: String?) = withContext(Dispatchers.IO) { RouteOpsStore(store()).temperature(deciC,checkpoint,outletId).also { schedule() } }
    suspend fun recordReturnable(outletId: String?,type: String,action: String,quantity: Long) = withContext(Dispatchers.IO) { RouteOpsStore(store()).returnable(outletId,type,action,quantity).also { schedule() } }
    suspend fun requestReload(productId: String,quantity: Long,note: String) = withContext(Dispatchers.IO) { RouteOpsStore(store()).reloadRequest(productId,quantity,note).also { schedule() } }
    suspend fun recordUnload() = withContext(Dispatchers.IO) { RouteOpsStore(store()).unload().also { schedule() } }
    suspend fun receiveReload(requestId: String) = withContext(Dispatchers.IO) { RouteOpsStore(store()).receiveReload(requestId).also { schedule() } }
    suspend fun recordDamage(productId: String, qty: Long, reason: String, note: String? = null, photoSha256: String? = null): String = TruckStockLedger(store(),::schedule).recordDamage(productId,qty,reason,note,photoSha256)
    suspend fun requestCallGeofence(outletId: String, reason: String, kind: String) = withContext(Dispatchers.IO) {
        if(kind == "geofence_end") syncNow()
        api.request("/api/v1/callflow/geofence/request",org.json.JSONObject().put("outletId",outletId).put("deviceId",store().scope.deviceId).put("reason",reason).put("kind",kind)); Unit
    }
    suspend fun callConfig(outletId: String): org.json.JSONObject? = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.VanCallStore(store()).config(outletId) }
    suspend fun openCall(): org.json.JSONObject? = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.VanCallStore(store()).current() }
    suspend fun recordCall(kind: String, outletId: String, fix: org.json.JSONObject?, options: org.json.JSONObject): String = withContext(Dispatchers.IO) {
        com.sunpride.field.sell.storage.VanCallStore(store()).record(kind,outletId,fix,options).also { schedule() }
    }
    suspend fun canRemove(productId: String, qty: Long): Boolean = store().canRemove(productId,qty)
    suspend fun addWalkInCustomer(name: String, reason: String): Customer = store().addWalkInCustomer(name,reason)
    suspend fun issueTransactionId(): com.sunpride.field.sell.ids.TransactionIdentity {
        val st = store(); val trip = checkNotNull(st.db.sellRows().trip(st.scope.fullAuthSubject,st.scope.deviceId))
        return com.sunpride.field.sell.ids.TransactionIds(st.db,st.scope).issue(trip.tripId,trip.tripNumber)
    }
    /**
     * VAN-011: validate and save a sale on this phone in one encrypted transaction (see `RoomVanStore.commitSale`).
     * Throws [com.sunpride.field.sell.pos.CheckoutRefused] with typed reasons; never needs the network.
     * v2 captures queue immediately; pre-v2 evidence remains parked in its separate held partition.
     */
    suspend fun retailCall(outletId: String) = withContext(Dispatchers.IO) {store().retailCall(outletId)}
    suspend fun retailSaved(callKey: String) = withContext(Dispatchers.IO) {store().retailSaved(callKey)}
    suspend fun saveRetail(call: com.sunpride.retail.RetailCall,callKey: String,answers: List<com.sunpride.retail.ShelfAnswer>,quantities: Map<String,Long>) = withContext(Dispatchers.IO) {
        store().saveRetail(call,callKey,answers,quantities)
        schedule()
    }
    suspend fun completeSale(request: com.sunpride.field.sell.pos.CheckoutRequest, expectedTotalMinor: Long): SaleReceipt =
        withContext(Dispatchers.IO) { store().commitSale(request,expectedTotalMinor).also { schedule() } }
    private val creditRequestEpoch=java.util.concurrent.atomic.AtomicLong()
    /** F-112: store an account snapshot only in the current authorization/request lifetime. */
    suspend fun checkCredit(body:JSONObject):JSONObject=withContext(Dispatchers.IO){
        val st=store();val lifetime=fiscalLifetime();val generation=creditRequestEpoch.incrementAndGet()
        val valid={lifetime()&&generation==creditRequestEpoch.get()&&st===current.value}
        check(valid()&&st.canSync()){"Sync the current account before checking credit"}
        try{
            val response=api.request("/api/v1/credit/check",body);currentCoroutineContext().ensureActive()
            val snapshot=response.getJSONObject("creditSnapshot")
            require(snapshot.getInt("version")==1&&snapshot.getString("customerCode")==body.getString("customerCode"))
            com.sunpride.integrity.RemoteErasure.recordingLock.withLock{
                check(valid()&&st.canSync()){"Credit session changed"}
                st.db.withTransaction{
                    val meta=checkNotNull(st.db.sellRows().meta(st.scope.fullAuthSubject,st.scope.deviceId))
                    val policy=JSONObject(checkNotNull(meta.policyJson));val fiscal=policy.getJSONObject("fiscal")
                    val views=fiscal.optJSONObject("creditSnapshots")?:JSONObject()
                    views.put(body.getString("outletId"),snapshot);fiscal.put("creditSnapshots",views)
                    currentCoroutineContext().ensureActive();check(valid()){"Credit session changed"}
                    st.db.sellRows().insertSyncMeta(meta.copy(policyJson=policy.toString()))
                }
            }
            response
        }catch(error:Exception){
            if(valid()&&error is AuthFailure&&error.kind in listOf(AuthFailure.Kind.REFUSED,AuthFailure.Kind.SESSION_EXPIRED)){
                com.sunpride.integrity.RemoteErasure.recordingLock.withLock{if(valid())runCatching{st.hold()}}
            }
            throw error
        }
    }
    /** F-404 the first-party SAP acknowledgement stays encrypted, exact-cart and lifetime-fenced. */
    suspend fun creditException(path:String,body:JSONObject,saleId:String,amount:Long,stillCurrent:()->Boolean):JSONObject=withContext(Dispatchers.IO){
        require(path in listOf("request-override","exception/status"))
        val st=store();val lifetime=fiscalLifetime();val generation=creditRequestEpoch.incrementAndGet()
        val valid={lifetime()&&generation==creditRequestEpoch.get()&&st===current.value&&stillCurrent()}
        check(valid()&&st.canSync()){"Sync this trip before asking for credit approval"}
        try{
            val answer=api.request("/api/v1/credit/$path",body);currentCoroutineContext().ensureActive()
            require(answer.getString("sourceId")==saleId&&answer.getString("sourceType")=="van_sale"&&answer.getLong("amountCentavos")==amount)
            require(answer.getString("customerCode")==body.getString("customerCode"))
            com.sunpride.integrity.RemoteErasure.recordingLock.withLock{
                check(valid()&&st.canSync()){"The credit request changed"}
                st.db.withTransaction{
                    val meta=checkNotNull(st.db.sellRows().meta(st.scope.fullAuthSubject,st.scope.deviceId));val policy=JSONObject(checkNotNull(meta.policyJson));val fiscal=policy.getJSONObject("fiscal")
                    val requests=fiscal.optJSONObject("sapCreditRequests")?:JSONObject();requests.put(saleId,answer);fiscal.put("sapCreditRequests",requests)
                    currentCoroutineContext().ensureActive();check(valid()){"The credit request changed"};st.db.sellRows().insertSyncMeta(meta.copy(policyJson=policy.toString()))
                }
            };answer
        }catch(error:Exception){
            if(valid()&&(error is NativeApiFailure&&error.status in 400..499||error is AuthFailure&&error.kind in listOf(AuthFailure.Kind.REFUSED,AuthFailure.Kind.SESSION_EXPIRED))){
                try{st.hold()}catch(_:Exception){current.value=null;gateway=null;session.value=SessionState()}
            };throw error
        }
    }
    /** F-110: retire answers independently of a same-account/scope renewal. */
    fun fiscalLifetime():()->Boolean {
        val st=current.value;val epoch=st?.authorizationEpoch();val session=sessionKey()
        return {st!=null&&st===current.value&&epoch==st.authorizationEpoch()&&session==sessionKey()&&access.isSignedIn}
    }
    suspend fun fiscalRequest(path:String,body:JSONObject):JSONObject=withContext(Dispatchers.IO){
        require(path in listOf("overrides/request","overrides/status"))
        val st=store();val valid=fiscalLifetime();check(valid()&&st===current.value&&st.canSync()){"Sync the current account before requesting approval"}
        try{api.request("/api/v1/fiscal/$path",body).also{check(valid()){"Approval session changed"}}}
        catch(error:Exception){
            if(valid() && (error is AuthFailure && error.kind==AuthFailure.Kind.REFUSED || error is NativeApiFailure && error.code=="authority_changed")){
                com.sunpride.integrity.RemoteErasure.recordingLock.withLock{
                    if(valid()&&st===current.value)runCatching{st.hold()} // latch precedes fallible durable hold
                }
            }
            throw error
        }
    }
    suspend fun voidSale(saleId: String, reason: String?, note: String?, code: String?): com.sunpride.field.sell.pos.SaleVoidResult =
        withContext(Dispatchers.IO) { store().voidSale(saleId,reason,note,code).also { schedule() } }
    /** IP-HOLD: carts parked on this phone (local only, never uploaded). */
    suspend fun heldCarts(surface: String): List<com.sunpride.field.sell.pos.HeldCart> = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.HeldCartStore(store()).list(surface) }
    suspend fun heldCount(surface: String): Int = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.HeldCartStore(store()).countNow(surface) }
    suspend fun holdCart(surface: String, name: String?, note: String?, customerId: String?, customerName: String?, lines: List<com.sunpride.field.sell.pos.HeldLine>, totalLabel: String): com.sunpride.field.sell.pos.HeldCart =
        withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.HeldCartStore(store()).hold(surface, name, note, customerId, customerName, lines, totalLabel) }
    suspend fun discardHeld(holdId: String) = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.HeldCartStore(store()).discard(holdId) }
    suspend fun discardAllHeld(surface: String) = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.HeldCartStore(store()).discardAll(surface) }
    /** IP-REFUND: what the refund screen needs for one saved sale (receipt lines, what is already refunded, the office's reasons and amount). */
    suspend fun refundContext(saleId: String): com.sunpride.field.sell.storage.RefundContext = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.RefundStore(store()).context(saleId) }
    /** IP-REFUND: save one refund (goods back on the truck, cash out of expected cash, credit memo number, parked `refund.record`). Idempotent on the request id. */
    suspend fun recordRefund(request: com.sunpride.field.sell.storage.RefundRequest): com.sunpride.field.sell.storage.RefundResult =
        withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.RefundStore(store()).commit(request).also { schedule() } }
    suspend fun refundSlip(refundId: String): com.sunpride.field.sell.printing.RefundSlipFacts? = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.RefundStore(store()).slip(refundId) }
    /** IP-REFUND: refunds of this trip (this phone's plus any only the office knows), for the "Refunded" line on the receipts list. */
    suspend fun refundsMade(tripId: String): List<com.sunpride.field.sell.pos.MadeRefund> = withContext(Dispatchers.IO) { com.sunpride.field.sell.storage.RefundStore(store()).made(tripId) }
    /** VAN-012: credit sold here per customer and references already used, so Checkout warns before the store refuses. */
    suspend fun paymentFacts(): com.sunpride.field.sell.storage.PaymentFacts = withContext(Dispatchers.IO) { store().paymentFacts() }
    /**
     * VAN-019: validate and save a customer return on this phone in one encrypted transaction (see `ReturnStore.commit`).
     * Throws [com.sunpride.field.sell.pos.ReturnRefused] with typed reasons; never needs the network. Parked like a sale.
     */
    suspend fun recordReturn(request: com.sunpride.field.sell.pos.ReturnRequest): com.sunpride.field.sell.pos.ReturnReceipt =
        withContext(Dispatchers.IO) { ReturnStore(store()).commit(request).also { schedule() } }
    /** VAN-019: sales saved here (to link a return to its receipt) and what was already returned against each. */
    suspend fun returnContext(): com.sunpride.field.sell.pos.ReturnContext = withContext(Dispatchers.IO) { ReturnStore(store()).context() }
    /**
     * VAN-017: print (or, when [explicit] with a reason, reprint) a sale saved on this phone. The attempt is recorded
     * in the scoped encrypted store before the printer is called; nothing about the sale itself changes.
     */
    suspend fun printReceipt(printer: com.sunpride.field.sell.printing.ReceiptPrinter, saleId: String, explicit: Boolean, reasonCode: String? = null): com.sunpride.field.sell.printing.PrintJobResult =
        withContext(Dispatchers.IO) { val st = store(); com.sunpride.field.sell.printing.ReceiptPrintFlow(printer,RoomReceiptPrintLog(st.db,st.scope)).print(saleId,explicit,reasonCode) }
    /** IP-P0: the seller's answer to "Did it print?" (confirmed or skipped), recorded on the latest attempt. */
    suspend fun settlePrint(saleId: String, outcome: com.sunpride.field.sell.printing.PrintOutcome) =
        withContext(Dispatchers.IO) { val st = store(); RoomReceiptPrintLog(st.db,st.scope).settle(saleId,outcome) }
    /** VAN-022: expected cash from this trip's saved sales and payments, and the saved count once there is one. */
    suspend fun cashSummary(): CashSummary? = withContext(Dispatchers.IO) { CashReconciliationStore(store()).summary() }
    /**
     * VAN-022: save the end-of-trip cash count in one encrypted transaction (see `CashReconciliationStore.commit`).
     * Throws [com.sunpride.field.sell.pos.CashRefused]; never needs the network. Parked like a sale; no upload is scheduled.
     */
    suspend fun countCash(request: com.sunpride.field.sell.pos.CashCountRequest): com.sunpride.field.sell.pos.CashCountResult =
        withContext(Dispatchers.IO) { CashReconciliationStore(store()).commit(request).also { schedule() } }
    /** VAN-023: expected truck stock and the saved physical count. */
    suspend fun stockSummary(): com.sunpride.field.sell.pos.StockSummary? = withContext(Dispatchers.IO) { StockReconciliationStore(store()).summary() }
    /** VAN-023: save the physical stock count; it remains parked until the gateway supports it. */
    suspend fun countStock(request: com.sunpride.field.sell.pos.StockCountRequest): com.sunpride.field.sell.pos.StockCountResult =
        withContext(Dispatchers.IO) { StockReconciliationStore(store()).commit(request).also { schedule() } }
    /** VAN-024: what must be done before closing the trip, and the saved close. */
    suspend fun closeSummary(): com.sunpride.field.sell.pos.TripCloseSummary? = withContext(Dispatchers.IO) { TripCloseStore(store()).summary() }
    /** VAN-024: close the trip on this phone; it remains parked until the gateway supports it. */
    suspend fun closeTrip(request: com.sunpride.field.sell.pos.TripCloseRequest): com.sunpride.field.sell.pos.TripCloseResult =
        withContext(Dispatchers.IO) { TripCloseStore(store()).commit(request).also { schedule() } }
    /** VAN-017: sales saved on the current trip with their print history, newest first. */
    suspend fun deliveryDrops(): List<JSONObject> = withContext(Dispatchers.IO) { VanCallStore(store()).deliveries() }
    /** F-303: photo/signature/quantities join the existing durable call outbox; no independent delivery queue. */
    suspend fun recordDelivery(outletId: String, capture: com.sunpride.field.sell.evidence.DamageCapture, fix: JSONObject, receiver: String, signature: org.json.JSONArray, lines: org.json.JSONArray, dropId: String): String = withContext(Dispatchers.IO) {
        val st=store(); val seller=checkNotNull(st.seller.first()); val at=System.currentTimeMillis()
        val customer=st.customers.first().single { it.outletId==outletId }
        val watermark=JSONObject().put("version",1).put("profileId",seller.profileId).put("outletId",outletId).put("capturedAt",at).put("latitude",fix.getDouble("latitude")).put("longitude",fix.getDouble("longitude"))
        val bytes=com.sunpride.field.sell.delivery.DeliveryPhotoEncoder.encode(capture,watermark,seller.name,customer.name)
        check(st === current.value && st.canSync())
        val photo=photoFiles(st.scope).save(bytes,90_000)
        VanCallStore(st).record("delivery.confirm",outletId,fix,JSONObject().put("deviceTime",at).put("dropId",dropId).put("signature",signature).put("receiverName",receiver).put("lines",lines).put("watermark",watermark).put("photoSha256",photo.sha256)).also { schedule() }
    }
    suspend fun recordCollection(paymentId: String,saleId: String,amount: Long,method: String,reference: String?) = withContext(Dispatchers.IO) {
        CollectionStore(store()).record(paymentId,saleId,amount,method,reference).also {schedule()}
    }
    suspend fun savedSales(): List<SavedSale> = withContext(Dispatchers.IO) { val st = store(); RoomReceiptPrintLog(st.db,st.scope).savedSales() }
    /** DEBUG practice data only: the fixture store, so device tests can seed the (still empty) price list. */
    internal fun fixtureStore(): RoomVanStore { check(BuildConfig.DEBUG && stubMode != null); return store() }
    suspend fun syncNow(): Unit = authLock.withLock {
        try {
            if (stubMode == null) enroll()
        } catch (e: AuthFailure) {
            // VAN-086: paused before the sync could start; Sync & posting must not keep saying the last sync finished.
            if (e.kind == AuthFailure.Kind.PAUSED) runCatching { current.value?.setHealth(com.sunpride.field.sell.sync.SyncHealth.PAUSED_HEALTH, null) }
            if (e.kind in setOf(AuthFailure.Kind.REFUSED,AuthFailure.Kind.SESSION_EXPIRED)) {
                try { current.value?.hold() } finally { current.value = null; gateway = null }
                // A revoked or expired session goes back to Sign in (work stays held on this phone),
                // never to an empty Today that reads like "no trip assigned".
                if (!access.isSignedIn) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut }
            }
            throw e
        }
        val st = store()
        try {
            VanSync(st,checkNotNull(gateway),evidence=st.evidence).syncNow(); session.value = SessionState(true)
        }
        catch (e: AuthFailure) {
            if (!access.isSignedIn) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut; current.value = null; gateway = null }
            throw e
        } catch (e: Exception) {
            // Keep the store: held work stays countable on screen; the next sync re-verifies the grant.
            if (!st.canSync()) gateway = null
            throw e
        }
        finally { if (st.pending().isNotEmpty()) schedule() }
    }
    /** VAN-083: the trip close is still waiting for the office to confirm the cash (the worker tries again later). */
    suspend fun closeWaitsForOffice(): Boolean = closeOffice.first() == com.sunpride.field.sell.pos.CloseOffice.WAITING_FOR_CASH
    /** Scope owned by the repository; never construct this from a UI-selected identity. */
    fun close() { lifetime.cancel(); current.value = null } // the Field database is shared; never closed here
    companion object {
        /** The background sender: the same repository, never scheduling itself again. */
        internal fun forWorker(context: Context, access: SellAccess, stub: Boolean): VanRepository =
            VanRepository(context.applicationContext,access,if (stub && BuildConfig.DEBUG) "ready" else null,scheduleWork=false)
        /** [stub] (DEBUG only): practice data, never the office. */
        fun create(context: Context, access: SellAccess, stub: Boolean = false): VanRepository =
            VanRepository(context.applicationContext,access,if (stub && BuildConfig.DEBUG) "ready" else null)
    }
}
