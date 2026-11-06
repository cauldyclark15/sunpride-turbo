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
    private val auth = AuthClient(environment,vault,deviceKey = {
        val key = loadSigner()
        JSONObject().put("keyId",hex(sha256(key.publicKeySpki))).put("publicKeySpki",key.publicKeyBase64)
    })
    private val api = NativeApi(environment,auth)
    private val devices = RestDeviceApi(api)
    fun replacementCode(): JSONObject = api.request("/api/v1/integrity/devices/pairing/start",
        com.sunpride.integrity.replacementPairingBody("van-android",companyKey(),loadSigner()::sign))
    fun sapMasters(refresh: Boolean): JSONObject? {
        val st=current.value ?: return null
        val session=sessionKey() ?: return null
        val raw=index.getString("$session.identity",null) ?: return null
        val identity=JSONObject(raw);val epoch=st.authorizationEpoch()
        val key=hex(sha256("$session|${st.scope.fullAuthSubject}|${st.scope.deviceId}".toByteArray()))
        val access=com.sunpride.catalogue.SapMasterAccess(context)
        val valid={session==sessionKey() && st===current.value && epoch==st.authorizationEpoch() && auth.isSignedIn && runBlocking {st.canSync()}}
        val read={runBlocking {st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId)?.policyJson?.let {JSONObject(it).optJSONObject("sapMasterMirror")?.toString()}}}
        fun display(state:JSONObject?):JSONObject? = state?.put("authorizationExpiresAt",runBlocking {st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId)?.let {minOf(it.leaseExpiresAt?:0L,it.cacheExpiresAt?:0L)}?:0L})
        if(!refresh)return display(access.cached(key,read,valid))
        val client=gateway as? VanSyncClient ?: return null
        val binding=com.sunpride.catalogue.SapMasterMirror.Binding("van-android",st.scope.deviceId,identity.getString("scopeId"),identity.getString("fingerprint"))
        return display(access.refresh(key,binding,read,{json->runBlocking {st.db.withTransaction {
            check(valid());val meta=checkNotNull(st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId))
            val policy=JSONObject(checkNotNull(meta.policyJson)).put("sapMasterMirror",JSONObject(json))
            st.db.rows().insertSyncMeta(meta.copy(policyJson=policy.toString()))
        }}},client::masterPull,valid,{e->e !is VanSyncFailure || e.code!="offline"}))
    }
    /** F-615 signed own-target snapshot, persisted only in the existing scoped encrypted metadata. */
    fun targetProgress(refresh:Boolean):com.sunpride.catalogue.TargetProgressView {
        val st=current.value?:return com.sunpride.catalogue.TargetProgressView(message="Sign in and sync to see targets")
        val sessionId=sessionKey()?:return com.sunpride.catalogue.TargetProgressView(message="Sign in and sync to see targets")
        val epoch=st.authorizationEpoch();val day=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).toString()
        val bound={sessionId==sessionKey()&&st===current.value&&epoch==st.authorizationEpoch()&&auth.isSignedIn}
        val valid={runCatching{bound()&&runBlocking{st.canSync()}}.getOrDefault(false)}
        val prefs=context.getSharedPreferences("van_projection_grants",Context.MODE_PRIVATE)
        val grant=com.sunpride.catalogue.ProjectionGrant("${st.scope}|$sessionId|$epoch","targets",{prefs.getString(it,null)},{k,v->prefs.edit().putString(k,v).commit()}).also{it.begin(day)}
        val cache=object:com.sunpride.catalogue.TargetProgressCache {
            override fun current()=grant.current()&&valid()
            override fun revoke(){if(!grant.deny())try{auth.signOut()}finally{this@VanRepository.session.value=SessionState();this@VanRepository.current.value=null;gateway=null}}
            override fun read(day:String):Pair<String,Long>? {
                if(!current())return null
                val saved=runBlocking{st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId)?.policyJson?.let{JSONObject(it).optJSONObject("targetProgressCache")}}?:return null
                if(saved.getString("day")!=day)return null
                return grant.read(saved.getString("wrapped"))?.let{it to saved.getLong("savedAt")}
            }
            override fun write(day:String,text:String,at:Long){
                val wrapped=checkNotNull(grant.wrap(text))
                runBlocking{com.sunpride.integrity.RemoteErasure.recordingLock.withLock {check(current());st.db.withTransaction{
                    check(bound()&&grant.current());val meta=checkNotNull(st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId))
                    val policy=JSONObject(checkNotNull(meta.policyJson)).put("targetProgressCache",JSONObject().put("day",day).put("wrapped",wrapped).put("savedAt",at))
                    st.db.rows().insertSyncMeta(meta.copy(policyJson=policy.toString()));check(bound()&&grant.current())
                }}}
            }
        }
        val fetch:(()->String)?=if(!refresh||stubMode!=null)null else ({
            val identity=JSONObject(checkNotNull(index.getString("$sessionId.identity",null)))
            val binding=com.sunpride.catalogue.SapMasterMirror.Binding("van-android",st.scope.deviceId,identity.getString("scopeId"),identity.getString("fingerprint"))
            val client=checkNotNull(gateway as? VanSyncClient)
            com.sunpride.catalogue.TargetProgressCodec.response(client.masterPull(com.sunpride.catalogue.TargetProgressCodec.request(binding,day)),binding,day)
        })
        return com.sunpride.catalogue.TargetProgressRepository.load(day,cache,System.currentTimeMillis(),fetch){e->e !is VanSyncFailure||e.code!="offline"}
    }
    fun sapMasterLifetime(): String? = if(auth.isSignedIn) current.value?.let {"${sessionKey()}|${it.scope}|${it.authorizationEpoch()}"} else null
    fun appUpdates() = com.sunpride.integrity.AppUpdateClient(context,environment.siteUrl,token={refresh->auth.accessToken(refresh)})
    private val index = context.getSharedPreferences(if(stubMode != null) "van_stub_identity_index" else "van_identity_index",Context.MODE_PRIVATE)
    private val current = MutableStateFlow<RoomVanStore?>(null)
    // A cached trip is not a grant. Expiry also withdraws already-visible reference data without a network.
    private val pulse: Flow<Long> = flow { while (currentCoroutineContext().isActive) { emit(System.currentTimeMillis()); delay(1_000) } }
    private val visible: Flow<RoomVanStore?> = current.flatMapLatest { st ->
        if (st == null || !st.scope.fullAuthSubject.startsWith("v2|")) flowOf(st)
        else combine(st.db.rows().observeSyncMeta(st.scope.fullAuthSubject,st.scope.deviceId),pulse) { metas,now ->
            if (metas.singleOrNull()?.authorizes(now) == true && st.canSync()) st else null
        }
    }.distinctUntilChanged()
    private val session = MutableStateFlow(SessionState())
    private val enrollment = MutableStateFlow<EnrollmentState>(EnrollmentState.SignedOut)
    val sessionState: StateFlow<SessionState> = session.asStateFlow()
    val enrollmentState: StateFlow<EnrollmentState> = enrollment.asStateFlow()
    val storePos: Flow<com.sunpride.van.storepos.StorePosState> = visible.flatMapLatest { it?.let { st -> com.sunpride.van.storepos.StorePosStore(st).state } ?: flowOf(com.sunpride.van.storepos.StorePosState(null,null,0,0)) }
    suspend fun openStoreShift(floatCentavos: Long) = withContext(Dispatchers.IO) { com.sunpride.van.storepos.StorePosStore(store()).open(floatCentavos).also { schedule() } }
    suspend fun closeStoreShift(countCentavos: Long) = withContext(Dispatchers.IO) { com.sunpride.van.storepos.StorePosStore(store()).close(countCentavos).also { schedule() } }
    suspend fun storeAction(kind:String,payload:JSONObject):String = withContext(Dispatchers.IO) { com.sunpride.van.storepos.StoreTransactions(store()).action(kind,payload).also {schedule()} }
    suspend fun storeSale(id:String,lines:List<com.sunpride.van.pos.CartLine>,tenders:List<com.sunpride.van.storepos.StoreTransactions.Tender>,total:Long,phone:String?,pin:String?,points:Long):JSONObject = withContext(Dispatchers.IO) {
        com.sunpride.van.storepos.StoreCheckout.customerLock.withLock {
            com.sunpride.van.storepos.StoreTransactions(store()).sale(id,lines,tenders,total,phone,pin,points).also {schedule()}
        }
    }
    /** IP-P0: print a store receipt through the same original/reprint rule as the van. */
    suspend fun storePrintReceipt(printer:com.sunpride.van.printing.ReceiptPrinter,saleId:String,explicit:Boolean,reasonCode:String?=null):com.sunpride.van.printing.PrintJobResult = withContext(Dispatchers.IO) {
        val tx=com.sunpride.van.storepos.StoreTransactions(store())
        com.sunpride.van.storepos.StorePrintFlow(printer,object:com.sunpride.van.storepos.StorePrintLog {
            override suspend fun begin(saleId:String,explicit:Boolean,reasonCode:String?)=tx.beginPrint(saleId,explicit,reasonCode)
            override suspend fun finish(printId:String,outcome:com.sunpride.van.printing.PrintOutcome)=tx.finishPrint(printId,outcome)
        }).print(saleId,explicit,reasonCode).also {schedule()}
    }
    suspend fun storePrintHistories():Map<String,List<com.sunpride.van.printing.PrintAttempt>> = withContext(Dispatchers.IO) {com.sunpride.van.storepos.StoreTransactions(store()).printHistories()}
    suspend fun storeSettlePrint(saleId:String,outcome:com.sunpride.van.printing.PrintOutcome) = withContext(Dispatchers.IO) {com.sunpride.van.storepos.StoreTransactions(store()).settlePrint(saleId,outcome)}
    suspend fun storeLookup(phone:String):JSONObject? = withContext(Dispatchers.IO) {
        com.sunpride.van.storepos.StoreCheckout.customerLock.withLock {
            val st=store();check(st.canSync());val epoch=st.authorizationEpoch()
            check(st.db.rows().outboxRows(st.scope.fullAuthSubject,st.scope.deviceId).none {row->
                row.kind=="store.sale"&&row.status in setOf("pending","sending")&&JSONObject(row.operationJson).getJSONObject("payload").optString("redeemPoints","0").toLong()>0
            }) {"Sync saved points sales before refreshing the balance"}
            val normalized=com.sunpride.van.storepos.StoreCheckout.normalizePhone(phone)
            val result=api.request("/api/v1/storepos/customers/lookup?phone="+java.net.URLEncoder.encode(normalized,"UTF-8")).optJSONObject("customer")
            result?.put("lookupId",java.util.UUID.randomUUID().toString())
            st.db.withTransaction {
                check(current.value===st && st.authorizationEpoch()==epoch && st.canSync())
                val meta=checkNotNull(st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId));val policy=JSONObject(checkNotNull(meta.policyJson))
                policy.getJSONObject("storePos").put("customerLookup",result?:JSONObject.NULL)
                st.db.rows().insertSyncMeta(meta.copy(policyJson=policy.toString()))
            }
            result
        }
    }
    suspend fun switchPosMode(mode:String,pin:String) = withContext(Dispatchers.IO) {
        val st=store();check(st.canSync());check(st.db.rows().outboxRows(st.scope.fullAuthSubject,st.scope.deviceId).none {it.status in setOf("pending","sending")}) {"Sync saved work before switching mode"}
        api.request("/api/v1/storepos/mode/switch",JSONObject().put("deviceId",st.scope.deviceId).put("mode",mode).put("pin",pin))
        syncNow()
    }
    suspend fun saveDepositPhoto(capture:com.sunpride.van.evidence.DamageCapture):String = withContext(Dispatchers.IO) {
        com.sunpride.integrity.RemoteErasure.recordingLock.withLock {
            val st=store();check(st.canSync())
            val bytes=com.sunpride.van.evidence.DamagePhotoEncoder.compress(capture,90000)
            check(st===current.value && st.canSync())
            photoFiles(st.scope).save(bytes,90000).sha256
        }
    }
    val currentTrip: Flow<Trip?> = visible.flatMapLatest { it?.trip ?: flowOf(null) }
    val load: Flow<Load?> = visible.flatMapLatest { it?.load ?: flowOf(null) }
    val loadLines: Flow<List<LoadLine>> = load.map { it?.lines ?: emptyList() }
    val seller: Flow<Seller?> = visible.flatMapLatest { it?.seller ?: flowOf(null) }
    val policy: Flow<VanPolicy?> = visible.flatMapLatest { it?.policy ?: flowOf(null) }
    val truckStock: Flow<List<TruckStock>> = visible.flatMapLatest { it?.truckStock ?: flowOf(emptyList()) }
    val damageRecords: Flow<List<DamageRecord>> = visible.flatMapLatest { it?.damageRecords ?: flowOf(emptyList()) }
    val products: Flow<List<Product>> = visible.flatMapLatest { it?.products ?: flowOf(emptyList()) }
    fun catalogueImage(image:com.sunpride.catalogue.CatalogueImage):ByteArray? = if(stubMode!=null)null else api.image(image)
    init { if(stubMode==null) lifetime.launch { products.collectLatest { rows ->
        val job=currentCoroutineContext()[Job]
        runCatching { com.sunpride.catalogue.warmCatalogueImages(context,rows.mapNotNull{it.catalogue},::catalogueImage){job?.isActive!=false} }
    } } }
    val customers: Flow<List<Customer>> = visible.flatMapLatest { it?.customers ?: flowOf(emptyList()) }
    val priceLines: Flow<List<PriceLine>> = visible.flatMapLatest { it?.priceLines ?: flowOf(emptyList()) }
    val promotions: Flow<List<Promotion>> = visible.flatMapLatest { it?.promotions ?: flowOf(emptyList()) }
    /** Signed in with a store whose office grant is held or expired: reference data is hidden, saved work is kept. */
    val onHold: Flow<Boolean> = combine(current,visible) { all,shown -> all != null && shown == null }
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
    init {
        api.onDeviceControl = { me ->
            runBlocking { com.sunpride.integrity.RemoteErasure.recordingLock.withLock {
                current.value?.hold()
                val subject=me.getJSONObject("profile").getString("subject")
                val device=me.getJSONObject("device").getString("id")
                val db=database ?: EncryptedVanDatabase.open(context).also { database=it }
                val partition=com.sunpride.integrity.PartitionRecovery.Partition("fullAuthSubject","v2|$subject|%",device,true)
                db.openHelper.writableDatabase.execSQL("update sync_meta set held=1,health='held_for_review' where fullAuthSubject like ? and deviceId=?",arrayOf(partition.accountPattern,device))
                val bundle=com.sunpride.integrity.PartitionRecovery.snapshot(db.openHelper.writableDatabase,partition)
                val files=mutableListOf<com.sunpride.integrity.RemoteErasure.RecoveryFile>()
                val accounts=mutableSetOf<String>()
                val tables=bundle.getJSONArray("tables")
                for(i in 0 until tables.length()) {
                    val rows=tables.getJSONObject(i).getJSONArray("rows")
                    for(n in 0 until rows.length()) accounts.add(rows.getJSONObject(n).getString("fullAuthSubject"))
                }
                for(account in accounts) {
                    val scoped=photoFiles(StoreScope(account,device))
                    for(file in scoped.directory.listFiles().orEmpty().filter {it.extension=="jpg"}) {
                        val key=Base64.getUrlEncoder().withoutPadding().encodeToString(account.toByteArray())+"/"+file.nameWithoutExtension
                        files.add(com.sunpride.integrity.RemoteErasure.RecoveryFile(key,scoped.read(file.nameWithoutExtension,96_000)))
                    }
                }
                com.sunpride.integrity.RemoteErasure.perform(context,me,bundle,files,
                    {loadSigner().sign(it)}, {path,body->api.request(path,body)},
                    {com.sunpride.integrity.PartitionRecovery.erase(db.openHelper.writableDatabase,partition)},
                    {key->val parts=key.split('/');require(parts.size==2)
                        val account=String(Base64.getUrlDecoder().decode(parts[0]))
                        require(account.startsWith("v2|$subject|"))
                        photoFiles(StoreScope(account,device)).delete(parts[1])},
                    {auth.signOut();index.edit().clear().commit();current.value=null;gateway=null
                        enrollment.value=EnrollmentState.SignedOut;session.value=SessionState()})
            } }
            throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        }
    }
    private fun sessionKey(): String? = vault.readSession()?.let { hex(sha256(it.toByteArray(Charsets.UTF_8))) }
    private fun attach(scope: StoreScope) {
        val db = database ?: (if(stubMode != null) EncryptedVanDatabase.openStub(context) else EncryptedVanDatabase.open(context)).also { database = it }
        if (current.value?.scope != scope) current.value = RoomVanStore(db,scope,evidence=photoFiles(scope))
    }
    private fun photoFiles(scope: StoreScope) = com.sunpride.van.evidence.DamagePhotoFiles(
        if (stubMode != null) java.io.File(context.noBackupFilesDir,"van-stub") else context.noBackupFilesDir,scope)
    suspend fun saveDamagePhoto(capture: com.sunpride.van.evidence.DamageCapture): com.sunpride.van.evidence.DamagePhoto = withContext(Dispatchers.IO) { com.sunpride.integrity.RemoteErasure.recordingLock.withLock {
        val st = store(); val policy = checkNotNull(st.policy.first())
        val maxBytes=policy.damagePolicy?.photoMaxBytes ?: 90_000
        // Explicit DEBUG practice fixture only; production never substitutes invented coordinates.
        val location = if (BuildConfig.DEBUG && stubMode != null) android.location.Location("SAMPLE practice fixture").apply {
            latitude=10.33; longitude=123.94; accuracy=5f; time=System.currentTimeMillis()
        } else com.sunpride.integrity.DeviceIntegrity.captureLocation(context)
        val person=checkNotNull(st.seller.first())
        val profile=if (BuildConfig.DEBUG && stubMode != null) "SAMPLE practice profile" else checkNotNull(devices.identity).profileId
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
            if (st === current.value && st.canSync() && st.db.rows().outboxRows(st.scope.fullAuthSubject,st.scope.deviceId).none { damagePhotoSha(it) == sha }) photoFiles(st.scope).delete(sha)
        }
    }
    /** F-113 photo bytes travel atomically in the encrypted return operation (32 KB maximum). */
    suspend fun prepareReturnPhoto(capture: com.sunpride.van.evidence.DamageCapture): String = withContext(Dispatchers.IO) {
        val bytes=com.sunpride.van.evidence.DamagePhotoEncoder.compress(capture,32_000)
        JSONObject().put("sha256",hex(sha256(bytes))).put("base64",Base64.getEncoder().encodeToString(bytes)).toString()
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
        val state = withContext(Dispatchers.IO) { Enrollment(devices,loadSigner(),vault).refresh() }
        enrollment.value = state
        if (state is EnrollmentState.Ready) {
            val identity = checkNotNull(devices.identity)
            val full = identity.partitionSubject; val key = checkNotNull(sessionKey())
            if (current.value?.scope != StoreScope(full,state.deviceId)) current.value?.hold()
            check(index.edit().putString("$key.subject",full).putString("$key.device",state.deviceId)
                .putString("$key.identity",JSONObject().put("subject",identity.subject).put("profileId",identity.profileId)
                    .put("scopeId",identity.scopeId).put("fingerprint",identity.fingerprint).put("epoch",identity.epoch).toString()).commit())
            attach(StoreScope(full,state.deviceId)); session.value = SessionState(true)
            gateway = VanSyncClient(LiveVanTransport(environment,auth,api),loadSigner(),state.deviceId,identity)
        } else { current.value?.hold(); current.value = null }
        return state
    }
    private fun cutover() {
        if (stubMode == null && index.getInt("transportGeneration",0) != 2) {
            // Open/migrate SQLCipher without deleting a single observation, ack or receipt.
            if (database == null) database = EncryptedVanDatabase.open(context)
            auth.invalidateAccessToken(); vault.wipe()
            check(index.edit().putInt("transportGeneration",2).commit())
        }
    }
    suspend fun restoreSession(): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            cutover()
            if(stubMode != null && vault.readSession() == null) vault.saveSession("debug-fixture-session")
            val key = sessionKey()
            if (key == null) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut; return@withContext }
            session.value = SessionState(true,true)
            val subject = index.getString("$key.subject",null); val device = index.getString("$key.device",null)
            if (subject != null && device != null && vault.deviceId == device) {
                attach(StoreScope(subject,device))
                index.getString("$key.identity",null)?.let { raw ->
                    val o = JSONObject(raw)
                    val identity = NativeIdentity(o.getString("subject"),o.getString("profileId"),o.getString("scopeId"),o.getString("fingerprint"),o.getString("epoch"))
                    check(identity.partitionSubject == subject)
                    gateway = VanSyncClient(LiveVanTransport(environment,auth,api),loadSigner(),device,identity)
                }
            }
            try { enroll() } catch (e: AuthFailure) {
                if (e.kind != AuthFailure.Kind.OFFLINE) { current.value?.hold(); current.value = null; if (!auth.isSignedIn) session.value = SessionState(); throw e }
                // Previously verified finite lease, not a new grant. Never unhold retained evidence offline.
                if (current.value?.canSync() == true && gateway != null && device != null) enrollment.value = EnrollmentState.Ready(device)
            }
            current.value?.resetSending()
            if (current.value?.pending()?.isNotEmpty() == true) schedule()
        }
    }
    suspend fun signIn(email: String, password: String): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            cutover()
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
    fun companyKey(): JSONObject = loadSigner().let { JSONObject().put("keyId",com.sunpride.van.device.RequestSigner.bodyDigest(it.publicKeySpki)).put("publicKeySpki",it.publicKeyBase64) }
    fun signCompanyMessage(message: String): String = loadSigner().sign(message)
    suspend fun companySignIn(tokens: JSONObject): Unit = authLock.withLock { withContext(Dispatchers.IO) {
        cutover(); current.value?.hold(); current.value=null; gateway=null
        auth.acceptCompanySession(tokens); session.value=SessionState(true,true); enroll(); Unit
    } }
    suspend fun changePassword(currentPassword: String, newPassword: String, confirm: String): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            PasswordChange.problem(currentPassword,newPassword,confirm)?.let { throw PasswordChangeFailure(it) }
            if (stubMode == null) auth.changePassword(currentPassword,newPassword,confirm)
        }
    }
    suspend fun setLocationConsent(enabled: Boolean): Unit = authLock.withLock { withContext(Dispatchers.IO) {
        if (stubMode == null) api.locationConsent(enabled)
    } }
    suspend fun refreshEnrollment(): EnrollmentState = authLock.withLock { withContext(Dispatchers.IO) { enroll() } }
    suspend fun signOut(): Unit = authLock.withLock {
        withContext(Dispatchers.IO) {
            try { current.value?.hold() } finally {
                current.value = null; gateway = null; enrollment.value = EnrollmentState.SignedOut; session.value = SessionState()
                if(stubMode != null) vault.wipe() else auth.signOut()
                // SP-0148: chat stops polling/sending and its saved messages, outbox and pictures go too.
                runCatching { com.sunpride.van.chat.VanChat.signOut(context) }
            }; Unit
        }
    }
    private fun store(): RoomVanStore { check(session.value.signedIn && vault.readSession() != null); return checkNotNull(current.value) { "Sign in and register this phone" } }
    private fun schedule() { if (scheduleWork) runCatching { SyncWork.enqueue(context,stubMode != null) }.onFailure { com.sunpride.van.diagnostics.SafeLog.event(context,"sync_retry") } }
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
    suspend fun batchPositions(): List<com.sunpride.van.ledger.BatchPosition> = withContext(Dispatchers.IO) { com.sunpride.van.ledger.BatchLedger(store()).positions() }
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
    suspend fun callConfig(outletId: String): org.json.JSONObject? = withContext(Dispatchers.IO) { com.sunpride.van.storage.VanCallStore(store()).config(outletId) }
    suspend fun openCall(): org.json.JSONObject? = withContext(Dispatchers.IO) { com.sunpride.van.storage.VanCallStore(store()).current() }
    suspend fun recordCall(kind: String, outletId: String, fix: org.json.JSONObject?, options: org.json.JSONObject): String = withContext(Dispatchers.IO) {
        com.sunpride.van.storage.VanCallStore(store()).record(kind,outletId,fix,options).also { schedule() }
    }
    suspend fun canRemove(productId: String, qty: Long): Boolean = store().canRemove(productId,qty)
    suspend fun addWalkInCustomer(name: String, reason: String): Customer = store().addWalkInCustomer(name,reason)
    suspend fun issueTransactionId(): com.sunpride.van.ids.TransactionIdentity {
        val st = store(); val trip = checkNotNull(st.db.rows().trip(st.scope.fullAuthSubject,st.scope.deviceId))
        return com.sunpride.van.ids.TransactionIds(st.db,st.scope).issue(trip.tripId,trip.tripNumber)
    }
    /**
     * VAN-011: validate and save a sale on this phone in one encrypted transaction (see `RoomVanStore.commitSale`).
     * Throws [com.sunpride.van.pos.CheckoutRefused] with typed reasons; never needs the network.
     * v2 captures queue immediately; pre-v2 evidence remains parked in its separate held partition.
     */
    suspend fun retailCall(outletId: String) = withContext(Dispatchers.IO) {store().retailCall(outletId)}
    suspend fun retailSaved(callKey: String) = withContext(Dispatchers.IO) {store().retailSaved(callKey)}
    suspend fun saveRetail(call: com.sunpride.retail.RetailCall,callKey: String,answers: List<com.sunpride.retail.ShelfAnswer>,quantities: Map<String,Long>) = withContext(Dispatchers.IO) {
        store().saveRetail(call,callKey,answers,quantities)
        schedule()
    }
    suspend fun completeSale(request: com.sunpride.van.pos.CheckoutRequest, expectedTotalMinor: Long): SaleReceipt =
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
                    val meta=checkNotNull(st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId))
                    val policy=JSONObject(checkNotNull(meta.policyJson));val fiscal=policy.getJSONObject("fiscal")
                    val views=fiscal.optJSONObject("creditSnapshots")?:JSONObject()
                    views.put(body.getString("outletId"),snapshot);fiscal.put("creditSnapshots",views)
                    currentCoroutineContext().ensureActive();check(valid()){"Credit session changed"}
                    st.db.rows().insertSyncMeta(meta.copy(policyJson=policy.toString()))
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
                    val meta=checkNotNull(st.db.rows().meta(st.scope.fullAuthSubject,st.scope.deviceId));val policy=JSONObject(checkNotNull(meta.policyJson));val fiscal=policy.getJSONObject("fiscal")
                    val requests=fiscal.optJSONObject("sapCreditRequests")?:JSONObject();requests.put(saleId,answer);fiscal.put("sapCreditRequests",requests)
                    currentCoroutineContext().ensureActive();check(valid()){"The credit request changed"};st.db.rows().insertSyncMeta(meta.copy(policyJson=policy.toString()))
                }
            };answer
        }catch(error:Exception){
            if(valid()&&(error is NativeApiFailure&&error.status in 400..499||error is AuthFailure&&error.kind in listOf(AuthFailure.Kind.REFUSED,AuthFailure.Kind.SESSION_EXPIRED))){
                try{st.hold()}catch(_:Exception){try{auth.signOut()}finally{current.value=null;gateway=null;session.value=SessionState()}}
            };throw error
        }
    }
    /** F-110: retire answers independently of a same-account/scope renewal. */
    fun fiscalLifetime():()->Boolean {
        val st=current.value;val epoch=st?.authorizationEpoch();val session=sessionKey()
        return {st!=null&&st===current.value&&epoch==st.authorizationEpoch()&&session==sessionKey()&&auth.isSignedIn}
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
    suspend fun voidSale(saleId: String, reason: String?, note: String?, code: String?): com.sunpride.van.pos.SaleVoidResult =
        withContext(Dispatchers.IO) { store().voidSale(saleId,reason,note,code).also { schedule() } }
    /** VAN-012: credit sold here per customer and references already used, so Checkout warns before the store refuses. */
    suspend fun paymentFacts(): com.sunpride.van.storage.PaymentFacts = withContext(Dispatchers.IO) { store().paymentFacts() }
    /**
     * VAN-019: validate and save a customer return on this phone in one encrypted transaction (see `ReturnStore.commit`).
     * Throws [com.sunpride.van.pos.ReturnRefused] with typed reasons; never needs the network. Parked like a sale.
     */
    suspend fun recordReturn(request: com.sunpride.van.pos.ReturnRequest): com.sunpride.van.pos.ReturnReceipt =
        withContext(Dispatchers.IO) { ReturnStore(store()).commit(request).also { schedule() } }
    /** VAN-019: sales saved here (to link a return to its receipt) and what was already returned against each. */
    suspend fun returnContext(): com.sunpride.van.pos.ReturnContext = withContext(Dispatchers.IO) { ReturnStore(store()).context() }
    /**
     * VAN-017: print (or, when [explicit] with a reason, reprint) a sale saved on this phone. The attempt is recorded
     * in the scoped encrypted store before the printer is called; nothing about the sale itself changes.
     */
    suspend fun printReceipt(printer: com.sunpride.van.printing.ReceiptPrinter, saleId: String, explicit: Boolean, reasonCode: String? = null): com.sunpride.van.printing.PrintJobResult =
        withContext(Dispatchers.IO) { val st = store(); com.sunpride.van.printing.ReceiptPrintFlow(printer,RoomReceiptPrintLog(st.db,st.scope)).print(saleId,explicit,reasonCode) }
    /** IP-P0: the seller's answer to "Did it print?" (confirmed or skipped), recorded on the latest attempt. */
    suspend fun settlePrint(saleId: String, outcome: com.sunpride.van.printing.PrintOutcome) =
        withContext(Dispatchers.IO) { val st = store(); RoomReceiptPrintLog(st.db,st.scope).settle(saleId,outcome) }
    /** VAN-022: expected cash from this trip's saved sales and payments, and the saved count once there is one. */
    suspend fun cashSummary(): CashSummary? = withContext(Dispatchers.IO) { CashReconciliationStore(store()).summary() }
    /**
     * VAN-022: save the end-of-trip cash count in one encrypted transaction (see `CashReconciliationStore.commit`).
     * Throws [com.sunpride.van.pos.CashRefused]; never needs the network. Parked like a sale; no upload is scheduled.
     */
    suspend fun countCash(request: com.sunpride.van.pos.CashCountRequest): com.sunpride.van.pos.CashCountResult =
        withContext(Dispatchers.IO) { CashReconciliationStore(store()).commit(request).also { schedule() } }
    /** VAN-023: expected truck stock and the saved physical count. */
    suspend fun stockSummary(): com.sunpride.van.pos.StockSummary? = withContext(Dispatchers.IO) { StockReconciliationStore(store()).summary() }
    /** VAN-023: save the physical stock count; it remains parked until the gateway supports it. */
    suspend fun countStock(request: com.sunpride.van.pos.StockCountRequest): com.sunpride.van.pos.StockCountResult =
        withContext(Dispatchers.IO) { StockReconciliationStore(store()).commit(request).also { schedule() } }
    /** VAN-024: what must be done before closing the trip, and the saved close. */
    suspend fun closeSummary(): com.sunpride.van.pos.TripCloseSummary? = withContext(Dispatchers.IO) { TripCloseStore(store()).summary() }
    /** VAN-024: close the trip on this phone; it remains parked until the gateway supports it. */
    suspend fun closeTrip(request: com.sunpride.van.pos.TripCloseRequest): com.sunpride.van.pos.TripCloseResult =
        withContext(Dispatchers.IO) { TripCloseStore(store()).commit(request).also { schedule() } }
    /** VAN-017: sales saved on the current trip with their print history, newest first. */
    suspend fun deliveryDrops(): List<JSONObject> = withContext(Dispatchers.IO) { VanCallStore(store()).deliveries() }
    /** F-303: photo/signature/quantities join the existing durable call outbox; no independent delivery queue. */
    suspend fun recordDelivery(outletId: String, capture: com.sunpride.van.evidence.DamageCapture, fix: JSONObject, receiver: String, signature: org.json.JSONArray, lines: org.json.JSONArray, dropId: String): String = withContext(Dispatchers.IO) {
        val st=store(); val seller=checkNotNull(st.seller.first()); val at=System.currentTimeMillis()
        val customer=st.customers.first().single { it.outletId==outletId }
        val watermark=JSONObject().put("version",1).put("profileId",seller.profileId).put("outletId",outletId).put("capturedAt",at).put("latitude",fix.getDouble("latitude")).put("longitude",fix.getDouble("longitude"))
        val bytes=com.sunpride.van.delivery.DeliveryPhotoEncoder.encode(capture,watermark,seller.name,customer.name)
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
            if (e.kind in setOf(AuthFailure.Kind.REFUSED,AuthFailure.Kind.SESSION_EXPIRED)) {
                try { current.value?.hold() } finally { current.value = null; gateway = null }
                // A revoked or expired session goes back to Sign in (work stays held on this phone),
                // never to an empty Today that reads like "no trip assigned".
                if (!auth.isSignedIn) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut }
            }
            throw e
        }
        val st = store()
        try {
            VanSync(st,checkNotNull(gateway),evidence=st.evidence).syncNow(); session.value = SessionState(true)
            if(stubMode==null) withContext(Dispatchers.IO) {runCatching {sapMasters(true)};runCatching{targetProgress(true)}}
        }
        catch (e: AuthFailure) {
            if (!auth.isSignedIn) { session.value = SessionState(); enrollment.value = EnrollmentState.SignedOut; current.value = null; gateway = null }
            throw e
        } catch (e: Exception) {
            // Keep the store: held work stays countable on screen; the next sync re-verifies the grant.
            if (!st.canSync()) gateway = null
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
            AppEnvironment(BuildConfig.API_ORIGIN),if (stub && BuildConfig.DEBUG) "ready" else null,scheduleWork=false)
        fun create(context: Context, intent: Intent? = null, stubMode: String? = null,
            environment: AppEnvironment = AppEnvironment(BuildConfig.API_ORIGIN)): VanRepository {
            val mode = (stubMode ?: intent?.getStringExtra(STUB_EXTRA))?.takeIf { BuildConfig.DEBUG && it in setOf("ready","unregistered","revoked") }
            return VanRepository(context.applicationContext,environment,mode)
        }
    }
}
