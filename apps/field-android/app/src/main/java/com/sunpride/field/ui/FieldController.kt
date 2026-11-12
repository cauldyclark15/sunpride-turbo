package com.sunpride.field.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import android.content.Context
import com.sunpride.field.storage.EncryptedFieldDatabase
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.withLock
import com.sunpride.field.storage.RoomFieldStore
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.ui.diagnosticvisit.CallSheetDraftLine
import com.sunpride.field.ui.diagnosticvisit.CallSheetPayload
import com.sunpride.field.storage.SnapshotItem
import com.sunpride.field.orders.OrderDraft
import com.sunpride.field.orders.OrderDraftFailure
import com.sunpride.field.orders.OrderDraftRules
import com.sunpride.field.storage.OrderTerms
import com.sunpride.field.storage.orderTerms
import com.sunpride.field.storage.VisitCallRules
import com.sunpride.field.storage.VisitRuleFailure
import com.sunpride.field.sync.BootstrapClient
import com.sunpride.field.sync.BootstrapFailure
import com.sunpride.field.sync.LiveBootstrapTransport
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.device.RequestSigner
import org.json.JSONObject
import org.json.JSONArray
import java.util.Base64
import java.time.LocalDate
import java.time.ZoneId
import java.security.MessageDigest
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ServerDeviceApi
import com.sunpride.field.auth.ServerError
import com.sunpride.field.auth.ServerFunctions
import com.sunpride.field.auth.Enrollment
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.auth.SessionVault
import com.sunpride.field.auth.SessionStorageFailure
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.fingerprint
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

/** Everything the screen needs from the network/Keystore; blocking calls, run on [FieldController.io]. */
interface FieldBackend {
    val isSignedIn: Boolean
    fun loadSigner(): DeviceSigner
    fun signIn(email: String, password: String)
    fun companySignIn(tokens: JSONObject) { error("Company sign-in unavailable") }
    fun replacementCode(): JSONObject { error("Replacement pairing unavailable") }
    fun sapMasters(refresh: Boolean): JSONObject? = null
    fun sapMasterLifetime(): String? = null
    fun creditControl(action:String,args:JSONObject):JSONObject {error("Connect to check credit control")}
    fun queueDomain(kind:String,payload:JSONObject,aggregate:String,dependencies:List<String>):String {error("Connect to refresh this form")}
    fun domainForms(kind:String,refresh:Boolean):JSONObject? = null
    fun appUpdates(): com.sunpride.integrity.AppUpdateClient? = null
    fun queueMockRefusal(outletId: String) { error("Integrity attempt storage unavailable") }
    fun signOut()
    fun changePassword(current: String, next: String, confirm: String) { error("Password change unavailable") }
    fun refreshEnrollment(signer: DeviceSigner): EnrollmentState
    fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData = TodayData()
    fun visitHistory(): List<com.sunpride.field.storage.IntentRow> = emptyList()
    fun visitStates(): List<Pair<com.sunpride.field.storage.IntentRow, String>> = emptyList()
    fun syncStatus(): com.sunpride.field.ui.syncstatus.SyncStatus = com.sunpride.field.ui.syncstatus.SyncStatus()
    fun schedulePendingWork() {}
    fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
        plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
        outcome: String?, reasonCode: String?, location: JSONObject?) { error("No local store") }
    fun requestGeofence(outletId: String, reason: String, kind: String) { error("Connect to request approval") }
    fun callFlow(outletId: String): JSONObject? = null
    fun queueConfiguredVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
        plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
        outcome: String?, reasonCode: String?, location: JSONObject?, options: JSONObject?) =
        queueVisit(kind,clientVisitId,checkInRequestId,previousRequestId,plannedVisitId,outletId,intents,unplannedReason,note,outcome,reasonCode,location)
    fun retailCall(outletId: String): com.sunpride.retail.RetailCall? = null
    fun saveRetail(call: com.sunpride.retail.RetailCall, clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        answers: List<com.sunpride.retail.ShelfAnswer>, quantities: Map<String,Long>): OrderDraft? = error("Availability unavailable")
    fun queueRetail(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        kind: String, data: JSONObject, photoIds: List<String>) { error("Sync to update merchandising access") }
    fun callSheet(outletId: String): CallSheet? = null
    fun queueCallSheet(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, drafts: List<CallSheetDraftLine>) { error("No local store") }
    /** AND-013 activity-form rules from the active snapshot. */
    fun activityRules(): List<com.sunpride.field.storage.ActivityRule> = emptyList()
    /** Queue one structured activity form (merchandising, promotion, inventory or price check). */
    fun queueActivity(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, activity: JSONObject) { error("No local store") }
    /** Local order drafts in this verified partition (SP-0061). */
    fun orderDrafts(): List<OrderDraft> = emptyList()
    /** Builds the association from the stored check-in and cached snapshot, then saves transactionally. */
    fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
        quantities: List<Pair<String, Int>>): OrderDraft = error("No local store")
    fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
        quantities: List<Pair<String, Int>>, units: Map<String, String>): OrderDraft =
        saveOrderDraft(draftId, clientVisitId, checkInRequestId, quantities)
    fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
        quantities: List<Pair<String, Int>>, units: Map<String, String>, requestedDeliveryDate: String?): OrderDraft =
        saveOrderDraft(draftId, clientVisitId, checkInRequestId, quantities, units)
    fun orderTerms(outletId: String): OrderTerms? = null
    fun discardOrderDraft(draftId: String) { error("No local store") }
    /** SP-0060: the review screen's locally checkable rules for one draft. */
    fun orderChecks(draftId: String): List<com.sunpride.field.orders.OrderCheck> = emptyList()
    /** Queue the reviewed draft's order after [previousRequestId] and mark it sent, in one transaction. */
    fun submitOrderDraft(draftId: String, previousRequestId: String): OrderDraft = error("No local store")
    val cachedDeviceId: String? get() = null
    /** AND-016: configured photo types (empty → provisional defaults). */
    fun earnedStatements(): List<com.sunpride.field.ui.incentives.EarnedStatement> = error("Connect to view earned statements")
    fun catalogueProducts(): List<com.sunpride.field.storage.CatalogProduct> = emptyList()
    fun catalogueImage(image:com.sunpride.catalogue.CatalogueImage):ByteArray? = null
    fun warmCatalogueImages(isActive:()->Boolean = {true}) {}
    fun censusConfig(): JSONObject? = null
    fun censusHistory(): List<Pair<String, String>> = emptyList()
    fun queueCensus(payload: JSONObject) { error("Census unavailable") }
    /** SP-0170 Add customer: PSGC geography kept on this phone (national pack + barangays of [provinces] and of
     * every province fetched before). Downloads what is missing or older than 30 days when online. */
    fun customerGeography(provinces: List<String>): com.sunpride.field.census.CustomerCapture.Geography? = null
    /** Edit store requests on this phone: (payload, outbox state, created at). */
    fun storeChanges(): List<Triple<JSONObject, String, Long>> = emptyList()
    /** The office's decisions on this person's sent store changes: fetched when online, else the copy saved on the phone. */
    fun storeDecisions(): Map<String, com.sunpride.field.census.CensusRules.Decision> = emptyMap()
    /** Rejected changes whose "Change not accepted" line was already shown on the store page. */
    fun seenRejections(): Set<String> = emptySet()
    fun markRejectionsSeen(ids: Set<String>) {}
    /** SP-0163 address search and duplicate check via our API proxy; null when there is no live session. */
    fun censusPlaces(): com.sunpride.field.census.CensusPlaces? = null
    fun photoTypes(): List<com.sunpride.field.storage.PhotoType> = emptyList()
    fun visitPhotos(clientVisitId: String): List<com.sunpride.field.storage.VisitPhoto> = emptyList()
    /** Seal the JPEG on the phone and record it for the open call; upload follows separately. */
    fun savePhoto(clientVisitId: String, checkInRequestId: String, outletId: String, photoType: String,
        jpeg: ByteArray, capturedAt: Long) { error("No local store") }
    /** F-209/F-222: non-call forms use the same partition, encrypted photo store and operation outbox. */
    fun workforceView(): com.sunpride.field.storage.WorkforceView = com.sunpride.field.storage.WorkforceView()
    fun queueWorkforce(kind: String,name: String,answers: Map<String,String>,geo: JSONObject?,jpeg: ByteArray?,photoAt: Long) { error("No workforce store") }
    /** Upload saved photos whose call has a server visit ID (background worker). */
    fun uploadEvidence(): com.sunpride.field.evidence.UploadReport = com.sunpride.field.evidence.UploadReport()
    /** AND-020: today's team summary (live, else saved on this phone); the server enforces scope. */
    fun team(directOnly: Boolean): com.sunpride.field.ui.team.TeamView =
        com.sunpride.field.ui.team.TeamView(message = "Team view isn't available on this phone.")
    /** ANA-010: today's suggested order for a call-sheet store (live, else saved today). Read-only. */
    fun suggestedOrder(outletId: String): com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView =
        com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(
            message = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.CONNECTION)
    /**
     * ANA-010: the current authorization lifetime (verified account/device/scope, session and enrollment).
     * A suggested-order answer is shown only while the epoch it was requested in is still current.
     */
    val authorizationEpoch: Long get() = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.epoch()
    /** The call sheet closed: an in-flight suggested-order answer must not be saved. */
    fun abandonSuggestedOrders() { com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.abandon() }
    /** SP-0136 live map: the work day that bounds location sharing; null where the host has none (previews). */
    val workDay: com.sunpride.field.location.WorkDayHost? get() = null
}

/** Shared by the live and test backends so both build drafts exactly the same way. */
suspend fun saveOrderDraftIn(store: com.sunpride.field.storage.FieldStore, draftId: String?, clientVisitId: String,
    checkInRequestId: String, quantities: List<Pair<String, Int>>, now: Long, units: Map<String, String> = emptyMap(), requestedDeliveryDate: String? = null): OrderDraft {
    val existing = draftId?.let { id -> store.orderDrafts().firstOrNull { it.draftId == id } ?: error("Unknown draft") }
    val draft = OrderDraftRules.build(store, existing, clientVisitId, checkInRequestId, quantities, now, units = units, requestedDeliveryDate = requestedDeliveryDate ?: existing?.requestedDeliveryDate)
    store.saveOrderDraft(draft, now)
    return draft
}

data class VisitDisplay(val outlet: String, val planned: String, val status: String,
    val outletId: String = "", val plannedVisitId: String? = null, val intents: List<String> = emptyList(),
    val sequence: Int? = null, val listPosition: Int? = null, val timeSpent: String? = null,
    /** Daily route facts from the cached snapshot; absent when an older server omitted them. */
    val outletCode: String? = null, val customerCode: String? = null, val address: String? = null,
    val latitude: Double? = null, val longitude: Double? = null,
    /** Activity facts of the finished call from the local outbox; null while open or not started. */
    val callFacts: com.sunpride.field.storage.ProductiveCall.Facts? = null,
    val serverExecution: String? = null,
    val agenda: com.sunpride.field.storage.CallAgenda? = null)
/** Planned row + cached outlet/customer JSON → what Today and the daily route show. Pure for tests. */
fun plannedVisitDisplay(row: SnapshotItem, outlets: Map<String, JSONObject>, customers: Map<String, String>): VisitDisplay {
    val v = JSONObject(row.json)
    val outlet = outlets[v.optString("outletId")]
    fun text(key: String) = outlet?.takeIf { it.has(key) && !it.isNull(key) }?.opt(key)
        ?.let { it as? String }?.takeIf { it.isNotBlank() }
    fun number(key: String) = outlet?.takeIf { it.has(key) && !it.isNull(key) }?.opt(key)
        ?.let { (it as? Number)?.toDouble() }?.takeIf { it.isFinite() }
    val latitude = number("latitude")?.takeIf { it in -90.0..90.0 }
    val longitude = number("longitude")?.takeIf { it in -180.0..180.0 }
    val pinned = latitude != null && longitude != null
    val server = com.sunpride.field.storage.ServerVisits.execution(row)
    val status = when (val state = server?.optString("state")) {
        in com.sunpride.field.storage.ServerVisits.CLOSED -> "Done"
        in com.sunpride.field.storage.ServerVisits.OPEN -> "In progress"
        "skipped" -> "Skipped"
        "missed" -> "Missed"
        "rescheduled" -> "Rescheduled"
        else -> "Scheduled"
    }
    return VisitDisplay(outlet?.optString("name", "Outlet") ?: "Outlet unavailable", "Planned", status,
        v.getString("outletId"), v.getString("id"),
        v.optJSONArray("intents")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
        VisitCallRules.sequence(row), row.listPosition,
        outletCode = text("code"), customerCode = text("customerId")?.let { customers[it] }?.takeIf { it.isNotBlank() },
        address = text("address"), latitude = latitude.takeIf { pinned }, longitude = longitude.takeIf { pinned },
        serverExecution = server?.toString(),
        agenda = v.optJSONObject("agenda")?.let(com.sunpride.field.storage.CallAgenda::decode))
}

data class TodayData(val visits: List<VisitDisplay> = emptyList(), val lastSynced: Long? = null,
                     val stale: Boolean = true, val warning: String? = null, val updateRequired: Boolean = false,
                     val reviewCount: Int = 0, val queuedCount: Int = 0,
                     val unplannedOutlets: List<VisitDisplay> = emptyList(),
                     val syncStatus: com.sunpride.field.ui.syncstatus.SyncStatus = com.sunpride.field.ui.syncstatus.SyncStatus(),
                     /** Scoped outlet directory from the same cached snapshot (customer search/detail). */
                     val customers: List<com.sunpride.field.ui.customers.CustomerRecord> = emptyList(),
                     val tasks: List<com.sunpride.field.ui.customers.CustomerTask> = emptyList(),
                     /** AND-020: offer the Team page (role hint from the snapshot; the server decides). */
                     val supervisor: Boolean = false,
                     val routeCode: String? = null,
                     /** Today's sales vs target from the daily sales report (live or saved). */
                     val sales: com.sunpride.field.ui.today.DaySalesView = com.sunpride.field.ui.today.DaySalesView(),
                      val targets:com.sunpride.catalogue.TargetProgressView=com.sunpride.catalogue.TargetProgressView(),
                     val partnerMode:Boolean=false,val partner:JSONObject?=null)

private const val TEAM_CACHE = "local.team"
private const val SALES_CACHE = "local.daysales"
/**
 * FLD-121: the phone-only cache row for a downloaded form agenda (`field.collections`, `field.jointcall`).
 * The encrypted store only keeps `local.` summaries, so the server topic is never the cache entity.
 */
internal fun domainFormsCacheEntity(topic: String): String = "local.$topic"
// Edit store: office decisions on this person's changes, and the rejections already shown (separate entities:
// putLocalCache keeps only one key prefix per entity).
private const val STORE_CHANGES = "local.storechanges"
/** SP-0170 offline PSGC geography for Add customer (public reference data; see docs/runbooks/CUSTOMER_MASTER.md). */
private const val GEOGRAPHY = "local.geography"
private const val GEOGRAPHY_MAX_AGE_MS = 30L * 24 * 3600_000
private val PSGC = Regex("^[0-9]{10}$")
private const val STORE_SEEN = "local.storeseen"

/**
 * Sign-out teardown (SP-0128). Every step runs even when an earlier one fails: a cache purge or index
 * clear that throws must never skip [authSignOut], which wipes the unlocked session, the ordinary and
 * sealed copies and the biometric key. The first failure is rethrown once everything has run.
 */
internal fun signOutTeardown(purgeCache: () -> Unit, clearIndex: () -> Unit, authSignOut: () -> Unit) {
    val failures = listOf(purgeCache, clearIndex, authSignOut).mapNotNull { step -> runCatching { step() }.exceptionOrNull() }
    failures.firstOrNull()?.let { throw it }
}

class LiveFieldBackend(
    environment: AppEnvironment,
    private val vault: SessionVault,
    private val context: Context,
    private val signerLoader: () -> DeviceSigner
) : FieldBackend {
    private val environmentOrigin = environment.apiOrigin.trimEnd('/')
    private val auth = AuthClient(environment, vault, signer = signerLoader)
    private val functions = ServerFunctions(environment, auth).also { it.signer = signerLoader }
    private val syncTransport = LiveBootstrapTransport(environment, auth, functions)
    private val visitTransport = com.sunpride.field.sync.LiveVisitTransport(environment, auth, functions)
    private val prefs = context.getSharedPreferences("field_v2_cache_index", Context.MODE_PRIVATE)
    init {
        functions.api.onDeviceControl = { me ->
            retireSuggestions()
            runBlocking { com.sunpride.integrity.RemoteErasure.recordingLock.withLock {
            val device = me.getJSONObject("device").getString("id")
            val account = "v2:${environmentOrigin}|${me.getJSONObject("profile").getString("subject")}"
            val scope = StoreScope(account, device, me.getJSONObject("scope").getString("fingerprint"))
            val store = EncryptedFieldDatabase.store(context, scope)
            val photoFiles = com.sunpride.field.evidence.KeystorePhotoFiles(context)
            try {
                store.freezeForRecovery()
                val bundle = store.recoveryBundle()
                val tables = bundle.getJSONArray("tables")
                val files = mutableListOf<com.sunpride.integrity.RemoteErasure.RecoveryFile>()
                for (i in 0 until tables.length()) {
                    val table = tables.getJSONObject(i)
                    if (table.getString("table") != "evidence_photos") continue
                    val rows = table.getJSONArray("rows")
                    for (n in 0 until rows.length()) {
                        val row = rows.getJSONObject(n)
                        val id = row.getString("localId")
                        if (row.getString("state") == "uploaded" && !photoFiles.exists(id)) continue
                        files.add(com.sunpride.integrity.RemoteErasure.RecoveryFile(id, photoFiles.read(id)))
                    }
                }
                com.sunpride.integrity.RemoteErasure.perform(context, me, bundle, files,
                    { signerLoader().sign(it) }, { path, body -> functions.api.post(path, body) },
                    { store.eraseRecoveredAccount() }, { id -> photoFiles.delete(id) },
                    { auth.signOut(); prefs.edit().clear().commit() })
            } finally { store.close() }
            } }
            throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        }
        val transport = context.getSharedPreferences("field_transport_epoch", Context.MODE_PRIVATE)
        if (transport.getInt("epoch", 0) != 2) {
            runBlocking { EncryptedFieldDatabase.holdExisting(context) }
            check(transport.edit().putInt("epoch", 2).commit())
        }
    }
    private fun storedScope(): StoreScope? {
        val key = sessionKey() ?: return null
        val account = prefs.getString("$key.subject", null) ?: return null
        val device = prefs.getString("$key.device", null) ?: return null
        val fingerprint = prefs.getString("$key.scope", null) ?: return null
        return StoreScope(account, device, fingerprint)
    }
    override fun visitStates(): List<Pair<com.sunpride.field.storage.IntentRow, String>> {
        val scope = storedScope() ?: return emptyList()
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking { store.history().map { it.first to it.second.state } } }
        finally { store.close() }
    }
    override fun visitHistory() = visitStates().map { it.first }
    override fun syncStatus(): com.sunpride.field.ui.syncstatus.SyncStatus {
        val scope = storedScope() ?: return com.sunpride.field.ui.syncstatus.SyncStatus()
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking { store.status() } } finally { store.close() }
    }
    override fun schedulePendingWork() {
        val status = syncStatus()
        if (status.queued + status.sending > 0 && status.health != "held_for_review")
            com.sunpride.field.sync.work.SyncWork.enqueue(context)
        if (status.photosWaiting > 0 && status.health != "held_for_review")
            com.sunpride.field.evidence.EvidenceWork.enqueue(context)
    }
    override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
        plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
        outcome: String?, reasonCode: String?, location: JSONObject?) =
        queueConfiguredVisit(kind,clientVisitId,checkInRequestId,previousRequestId,plannedVisitId,outletId,intents,unplannedReason,note,outcome,reasonCode,location,null)
    override fun queueConfiguredVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
        plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
        outcome: String?, reasonCode: String?, location: JSONObject?, options: JSONObject?) {
        val scope = storedScope() ?: error("No verified local partition")
        val store = EncryptedFieldDatabase.store(context, scope)
        try {
            runBlocking {
                val original = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, kind, clientVisitId,
                    checkInRequestId, previousRequestId, plannedVisitId, outletId, intents, unplannedReason,
                    note, outcome, reasonCode, location)
                val json = JSONObject(original.serializedOperation)
                options?.let { opts -> listOf("sequenceReason","shortCallReason","zeroSaleReason","geofenceApprovalId","locationUnavailable").forEach { key ->
                    if (opts.has(key)) json.getJSONObject("payload").put(key,opts.get(key))
                } }
                val intent = original.copy(serializedOperation = json.toString())
                com.sunpride.field.sync.work.QueueScheduler.enqueue(store, intent, System.currentTimeMillis()) {
                    com.sunpride.field.sync.work.SyncWork.enqueue(context)
                }
            }
        } finally { store.close() }
    }
    override fun requestGeofence(outletId: String, reason: String, kind: String) {
        val partition=storedScope() ?: error("No verified phone")
        if(kind == "geofence_end") today(partition.deviceId,loadSigner(),true)
        functions.api.post("/api/v1/callflow/geofence/request",JSONObject().put("outletId",outletId).put("deviceId",partition.deviceId).put("reason",reason).put("kind",kind))
    }
    override fun callFlow(outletId: String): JSONObject? {
        val partition = storedScope() ?: return null
        val store = EncryptedFieldDatabase.store(context,partition)
        return try { runBlocking { store.outlets().firstOrNull { it.id == outletId }?.let { JSONObject(it.json).optJSONObject("callFlow") } } } finally { store.close() }
    }
    override fun retailCall(outletId: String): com.sunpride.retail.RetailCall? = withStore { store ->
        if (!store.isLeaseValid(System.currentTimeMillis())) null else com.sunpride.field.storage.RetailQueueRules.call(store,outletId)
    }
    override fun saveRetail(call: com.sunpride.retail.RetailCall, clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        answers: List<com.sunpride.retail.ShelfAnswer>, quantities: Map<String,Long>): OrderDraft? {
        val identity=storedScope() ?: error("No verified local partition")
        val draft=withStore { store -> store.retailTransaction {
            val current=com.sunpride.field.storage.RetailQueueRules.call(store,call.outletId)
            check(current==call) {"The downloaded MSL changed. Reopen this call."}
            require(quantities.keys.all {id->call.lines.any {it.productId==id}} && quantities.values.all {it in 0L..1_000_000_000L}) {"Use whole, non-negative quantities"}
            check(!com.sunpride.field.storage.RetailQueueRules.saved(clientVisitId,store.history().map {it.first to it.second.state})) {"Availability already saved for this call"}
            val at=System.currentTimeMillis(); val checkId=java.util.UUID.randomUUID().toString()
            var previous=previousRequestId
            suspend fun queue(kind: String,payload: JSONObject) {
                val request=java.util.UUID.randomUUID().toString()
                payload.put("visitId","@checkin:$checkInRequestId").put("deviceTime",at)
                val op=JSONObject().put("kind",kind).put("clientRequestId",request)
                    .put("dependsOn",org.json.JSONArray().put(previous)).put("payload",payload)
                store.enqueue(com.sunpride.field.storage.IntentRow(identity.account,identity.deviceId,identity.fingerprint,
                    request,clientVisitId,kind,op.toString(),at),at)
                previous=request
            }
            queue("availability.record",com.sunpride.retail.RetailAvailability.payload(call,answers,checkId,clientVisitId,at))
            val units=mutableMapOf<String,String>()
            val proposed=quantities.filterValues {it>0}.map { (productId,base) ->
                val line=call.lines.single {it.productId==productId}
                require(base%line.scale==0L && base/line.scale in 1..99999) {"Use whole ${line.uom} quantities for ${line.name}"}
                units[productId]=line.uom
                productId to (base/line.scale).toInt()
            }
            val saved=if(proposed.isEmpty())null else saveOrderDraftIn(store,null,clientVisitId,checkInRequestId,proposed,at,units)
            for(answer in answers.filter {it.state=="absent"}) {
                val q=quantities[answer.productId] ?: 0L
                queue("availability.proposal",JSONObject().put("decisionId",java.util.UUID.randomUUID().toString())
                    .put("checkId",checkId).put("productId",answer.productId).put("decision",if(q>0)"accepted" else "dismissed")
                    .put("quantityBase",q).put("orderKey",saved?.draftId ?: JSONObject.NULL))
            }
            saved
        } }
        runCatching { com.sunpride.field.sync.work.SyncWork.enqueue(context) }
        return draft
    }
    override fun callSheet(outletId: String): CallSheet? {
        val scope = storedScope() ?: return null
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking { store.callSheet(outletId) } } finally { store.close() }
    }
    override fun queueCallSheet(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, drafts: List<CallSheetDraftLine>) {
        val scope = storedScope() ?: error("No verified local partition")
        val store = EncryptedFieldDatabase.store(context, scope)
        try { runBlocking {
            val sheet = store.callSheet(outletId) ?: error("No call sheet for this account")
            val activity = CallSheetPayload.activity(sheet, drafts)
            val intent = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, "visit.activity",
                clientVisitId, checkInRequestId, previousRequestId, null, outletId, emptyList(),
                null, null, null, null, null, callSheet = activity)
            com.sunpride.field.sync.work.QueueScheduler.enqueue(store, intent, System.currentTimeMillis()) {
                com.sunpride.field.sync.work.SyncWork.enqueue(context)
            }
        } } finally { store.close() }
    }
    override fun activityRules(): List<com.sunpride.field.storage.ActivityRule> {
        val scope = storedScope() ?: return emptyList()
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking { store.activityRules() } } finally { store.close() }
    }
    override fun earnedStatements(): List<com.sunpride.field.ui.incentives.EarnedStatement> =
        com.sunpride.field.ui.incentives.EarnedStatements.decode(functions.api.get(com.sunpride.field.ui.incentives.EarnedStatements.PATH))
    override fun catalogueImage(image:com.sunpride.catalogue.CatalogueImage):ByteArray? = functions.api.image(image)
    override fun warmCatalogueImages(isActive:()->Boolean) {
        com.sunpride.catalogue.warmCatalogueImages(context,catalogueProducts().mapNotNull { it.catalogue },::catalogueImage,isActive)
    }
    override fun catalogueProducts(): List<com.sunpride.field.storage.CatalogProduct> = withStore { store ->
        val epoch=authorizationEpoch
        val result=store.catalog()
        check(epoch==authorizationEpoch) { "Session changed" }
        result
    }
    override fun censusConfig(): JSONObject? = withStore { store ->
        val cached = com.sunpride.field.census.CensusConfigCache.load(
            now=System.currentTimeMillis(),epoch={authorizationEpoch},
            generation={
                val current=storedScope();val session=sessionKey()
                if(current==null||session==null)null else runBlocking {
                    store.censusCacheGrant(current,System.currentTimeMillis())?.let { "$it:$session" }
                }
            },
            read={runBlocking { store.localCache("local.census","config")?.takeUnless { it.tombstone }?.json }},
            block={runBlocking { store.blockLocalCache("local.census","config","checking",System.currentTimeMillis()) }},
            write={json->runBlocking { store.putLocalCache("local.census","config",json,JSONObject(json).getLong("savedAt"),"config") }},
            fetch={functions.api.get("/api/v1/masters/census-config").toString()},
            isOffline={it is com.sunpride.field.auth.AuthFailure&&it.kind==com.sunpride.field.auth.AuthFailure.Kind.OFFLINE})
        cached?.let(::JSONObject)
    }
    override fun customerGeography(provinces: List<String>): com.sunpride.field.census.CustomerCapture.Geography? =
        if (storedScope() == null) null else withStore { store ->
            val now = System.currentTimeMillis()
            suspend fun cachedOrFetch(key: String, path: String): String? {
                val saved = store.localCache(GEOGRAPHY, key)?.takeUnless { it.tombstone }
                if (saved?.json != null && now - saved.revision in 0 until GEOGRAPHY_MAX_AGE_MS) return saved.json
                val live = runCatching { functions.api.get(path).toString() }.getOrNull()
                if (live != null) runCatching { store.putLocalCache(GEOGRAPHY, key, live, now, "") }
                return live ?: saved?.json
            }
            val pack = cachedOrFetch("pack", "/api/v1/geography/pack") ?: return@withStore null
            var geography = com.sunpride.field.census.CustomerCapture.Geography.parse(JSONObject(pack))
            val known = store.localCache(GEOGRAPHY, "provinces")?.takeUnless { it.tombstone }?.json
                ?.let { runCatching { org.json.JSONArray(it) }.getOrNull() }
                ?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } }.orEmpty()
            val wanted = (provinces + known).filter { PSGC.matches(it) }.distinct().take(40)
            val got = mutableListOf<String>()
            for (province in wanted) {
                val text = cachedOrFetch("brgy:$province", "/api/v1/geography/pack/barangays?provinceCode=$province") ?: continue
                geography = geography.withBarangays(province,
                    com.sunpride.field.census.CustomerCapture.Geography.barangays(JSONObject(text)))
                got += province
            }
            if (got.toSet() != known.toSet())
                runCatching { store.putLocalCache(GEOGRAPHY, "provinces", org.json.JSONArray(got).toString(), now, "") }
            geography
        }
    override fun censusHistory(): List<Pair<String, String>> = withStore { store ->
        store.history().filter { it.first.kind == com.sunpride.field.census.CensusRules.KIND }.map {
            JSONObject(it.first.serializedOperation).getJSONObject("payload").getString("name") to it.second.state
        }
    }
    override fun storeChanges(): List<Triple<JSONObject, String, Long>> = if (storedScope() == null) emptyList() else withStore { store ->
        store.history().filter { it.first.kind == com.sunpride.field.census.CensusRules.KIND }.map {
            Triple(JSONObject(it.first.serializedOperation).getJSONObject("payload"), it.second.state, it.first.createdAt)
        }.filter { com.sunpride.field.census.CensusRules.isChange(it.first) }
    }
    override fun storeDecisions(): Map<String, com.sunpride.field.census.CensusRules.Decision> =
        if (storedScope() == null) emptyMap() else withStore { store ->
            val live = runCatching { functions.api.get("/api/v1/masters/census/my-changes").toString() }.getOrNull()
            if (live != null) store.putLocalCache(STORE_CHANGES, "decisions", live, System.currentTimeMillis(), "decisions")
            val text = live ?: store.localCache(STORE_CHANGES, "decisions")?.takeUnless { it.tombstone }?.json
            com.sunpride.field.census.CensusRules.decisions(text?.let { runCatching { JSONObject(it) }.getOrNull() })
        }
    override fun seenRejections(): Set<String> = if (storedScope() == null) emptySet() else withStore { store ->
        store.localCache(STORE_SEEN, "seen")?.takeUnless { it.tombstone }?.json
            ?.let { runCatching { org.json.JSONArray(it) }.getOrNull() }
            ?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String }.toSet() }.orEmpty()
    }
    override fun markRejectionsSeen(ids: Set<String>) {
        if (ids.isEmpty() || storedScope() == null) return
        withStore { store ->
            val old = store.localCache(STORE_SEEN, "seen")?.takeUnless { it.tombstone }?.json
                ?.let { runCatching { org.json.JSONArray(it) }.getOrNull() }
                ?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } }.orEmpty()
            // Keep the newest 200 ids: the server lists at most the newest 100 decisions.
            val all = (old + ids).distinct().takeLast(200)
            store.putLocalCache(STORE_SEEN, "seen", org.json.JSONArray(all).toString(), System.currentTimeMillis(), "seen")
        }
    }
    override fun censusPlaces(): com.sunpride.field.census.CensusPlaces =
        com.sunpride.field.census.CensusPlaces({ path -> functions.api.get(path) }, { path, body -> functions.api.post(path, body) })
    override fun queueCensus(payload: JSONObject) {
        val scope = storedScope() ?: error("No verified local partition")
        withStore { store ->
            val at = System.currentTimeMillis()
            store.enqueue(com.sunpride.field.census.CensusRules.intent(scope, payload, at), at)
        }
        runCatching { com.sunpride.field.sync.work.SyncWork.enqueue(context) }
    }
    override fun photoTypes(): List<com.sunpride.field.storage.PhotoType> {
        val scope = storedScope() ?: return emptyList()
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking { store.photoTypes() } } finally { store.close() }
    }
    override fun visitPhotos(clientVisitId: String): List<com.sunpride.field.storage.VisitPhoto> {
        val scope = storedScope() ?: return emptyList()
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking { store.visitPhotos(clientVisitId).map { com.sunpride.field.storage.EvidencePhotos.view(it) } } }
        finally { store.close() }
    }
    override fun savePhoto(clientVisitId: String, checkInRequestId: String, outletId: String, photoType: String,
        jpeg: ByteArray, capturedAt: Long) {
        runBlocking { com.sunpride.integrity.RemoteErasure.recordingLock.withLock {
        val scope = storedScope() ?: error("No verified local partition")
        require(com.sunpride.field.storage.EvidencePhotos.isJpeg(jpeg) &&
            jpeg.size.toLong() in 1..com.sunpride.field.storage.EvidencePhotos.MAX_BYTES) { "Invalid photo" }
        val files = com.sunpride.field.evidence.KeystorePhotoFiles(context)
        val at = System.currentTimeMillis()
        val fix = com.sunpride.integrity.DeviceIntegrity.captureLocation(context, at, com.sunpride.field.BuildConfig.E2E_MOCK_LOCATION)
        val snapshot = EncryptedFieldDatabase.store(context, scope)
        val captureFacts = try { runBlocking {
            val me = snapshot.employeeId() ?: error("Missing verified person")
            val outlet = snapshot.outlets().firstOrNull { it.id == outletId }?.let { JSONObject(it.json) }
                ?: error("Missing verified outlet")
            val key = sessionKey()
            val employee = com.sunpride.field.storage.EvidencePhotos.watermarkPerson(snapshot.employeeName(), me,
                key?.let { prefs.getString("$it.personId", null) }, key?.let { prefs.getString("$it.personName", null) })
                ?: error("Missing verified person name")
            com.sunpride.integrity.ExecutionWatermark.Facts(fix.latitude, fix.longitude, fix.accuracy.toDouble(),
                capturedAt, employee, me, outlet.optString("name").ifBlank { outlet.optString("code") }, outletId)
        } } finally { snapshot.close() }
        val watermarked = com.sunpride.integrity.ExecutionWatermark.burn(jpeg, captureFacts)
        val localId = java.util.UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        // F-312: pixels and capture metadata are frozen BEFORE hashing and encryption.
        files.write(localId, watermarked)
        val store = EncryptedFieldDatabase.store(context, scope)
        try {
            runBlocking {
                store.addPhoto(com.sunpride.field.storage.EvidencePhotoRow(scope.account, scope.deviceId,
                    scope.fingerprint, localId, clientVisitId, checkInRequestId, outletId, photoType,
                    com.sunpride.field.storage.EvidencePhotos.MIME, watermarked.size.toLong(),
                    com.sunpride.field.storage.EvidencePhotos.sha256Hex(watermarked), capturedAt, now), now)
            }
        } catch (e: Exception) { files.delete(localId); throw e }
        finally { store.close() }
        com.sunpride.field.diagnostics.SafeLog.event(context, "photo_saved")
        runCatching { com.sunpride.field.evidence.EvidenceWork.enqueue(context) }
        } }
    }
    override fun workforceView(): com.sunpride.field.storage.WorkforceView {
        if(storedScope()==null)return com.sunpride.field.storage.WorkforceView()
        return withStore { store->com.sunpride.field.storage.WorkforceForms.view(store.workforcePolicy(),store.history().map { it.first to it.second.state },System.currentTimeMillis()) }
    }
    override fun queueWorkforce(kind: String,name: String,answers: Map<String,String>,geo: JSONObject?,jpeg: ByteArray?,photoAt: Long) {
        val scope=storedScope()?:error("No verified partition")
        val epoch=authorizationEpoch
        val store=EncryptedFieldDatabase.store(context,scope)
        val files=com.sunpride.field.evidence.KeystorePhotoFiles(context)
        var localPhoto: String?=null
        try { runBlocking {
            val policy=store.workforcePolicy()?:error("Refresh today's field forms.")
            val history=store.history().map { it.first to it.second.state }
            val at=System.currentTimeMillis()
            val view=com.sunpride.field.storage.WorkforceForms.view(policy,history,at)
            val pair=com.sunpride.field.storage.WorkforceForms.create(scope,policy,kind,name,answers,geo,jpeg,photoAt,at,view.clockInRequestId,history.any { it.first.requestId==view.clockInRequestId })
            pair.second?.let { photo->files.write(photo.localId,requireNotNull(jpeg));localPhoto=photo.localId }
            store.enqueueWorkforce(pair.first,pair.second,at) { runCatching { authorizationEpoch==epoch && storedScope()==scope }.getOrDefault(false) }
        } } catch(e: Exception) { localPhoto?.let { runCatching { files.delete(it) } };throw e }
        finally { store.close() }
        com.sunpride.field.sync.work.SyncWork.enqueue(context)
        if(localPhoto!=null)com.sunpride.field.evidence.EvidenceWork.enqueue(context)
    }
    override fun uploadEvidence(): com.sunpride.field.evidence.UploadReport {
        val scope = storedScope() ?: return com.sunpride.field.evidence.UploadReport()
        val epoch=authorizationEpoch
        val store = EncryptedFieldDatabase.store(context, scope)
        val report=try {
            runBlocking { com.sunpride.field.evidence.EvidenceUploader(store, scope,
                com.sunpride.field.evidence.KeystorePhotoFiles(context),
                com.sunpride.field.evidence.ServerEvidenceApi(functions))
                .whileAuthorized { runCatching { epoch==authorizationEpoch && storedScope()==scope }.getOrDefault(false) }.run() }
        } finally { store.close() }
        if(report.uploaded>0)com.sunpride.field.sync.work.SyncWork.enqueue(context)
        com.sunpride.field.evidence.EvidenceWork.notifyFinished(report)
        return report
    }
    override fun queueActivity(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, activity: JSONObject) {
        val scope = storedScope() ?: error("No verified local partition")
        val store = EncryptedFieldDatabase.store(context, scope)
        try { runBlocking {
            val intent = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, "visit.activity",
                clientVisitId, checkInRequestId, previousRequestId, null, outletId, emptyList(),
                null, null, null, null, null, activity = activity)
            com.sunpride.field.sync.work.QueueScheduler.enqueue(store, intent, System.currentTimeMillis()) {
                com.sunpride.field.sync.work.SyncWork.enqueue(context)
            }
        } } finally { store.close() }
    }
    override fun queueRetail(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        kind: String, data: JSONObject, photoIds: List<String>) {
        val identity=storedScope() ?: error("No verified local partition")
        withStore { store ->
            val start=store.intent(checkInRequestId) ?: error("Start the call first")
            require(start.clientVisitId==clientVisitId)
            val intent=com.sunpride.field.storage.RetailCaptureQueue.create(identity,start,previousRequestId,kind,data,photoIds,System.currentTimeMillis())
            com.sunpride.field.sync.work.QueueScheduler.enqueue(store,intent,System.currentTimeMillis()) {
                com.sunpride.field.sync.work.SyncWork.enqueue(context)
            }
        }
        com.sunpride.field.evidence.EvidenceWork.enqueue(context)
    }
    private fun <T> withStore(block: suspend (RoomFieldStore) -> T): T {
        val scope = storedScope() ?: error("No verified local partition")
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking { block(store) } } finally { store.close() }
    }
    override fun orderDrafts(): List<OrderDraft> = if (storedScope() == null) emptyList() else withStore { it.orderDrafts() }
    override fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
        quantities: List<Pair<String, Int>>): OrderDraft = withStore {
        saveOrderDraftIn(it, draftId, clientVisitId, checkInRequestId, quantities, System.currentTimeMillis())
    }
    override fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
        quantities: List<Pair<String, Int>>, units: Map<String, String>): OrderDraft = withStore {
        saveOrderDraftIn(it, draftId, clientVisitId, checkInRequestId, quantities, System.currentTimeMillis(), units)
    }
    override fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
        quantities: List<Pair<String, Int>>, units: Map<String, String>, requestedDeliveryDate: String?): OrderDraft = withStore {
        saveOrderDraftIn(it, draftId, clientVisitId, checkInRequestId, quantities, System.currentTimeMillis(), units, requestedDeliveryDate)
    }
    override fun orderTerms(outletId: String): OrderTerms? = withStore { it.orderTerms(outletId) }
    override fun discardOrderDraft(draftId: String) = withStore { it.discardOrderDraft(draftId) }
    override fun orderChecks(draftId: String): List<com.sunpride.field.orders.OrderCheck> = withStore { store ->
        val draft = store.orderDrafts().firstOrNull { it.draftId == draftId } ?: return@withStore emptyList()
        com.sunpride.field.orders.OrderSubmission.checks(store, draft, System.currentTimeMillis())
    }
    override fun submitOrderDraft(draftId: String, previousRequestId: String): OrderDraft {
        val scope = storedScope() ?: error("No verified local partition")
        val sent = withStore {
            com.sunpride.field.orders.submitOrderDraftIn(it, scope, draftId, previousRequestId, System.currentTimeMillis())
        }
        // Only after the committed transaction: a scheduler failure cannot uncommit the queued order.
        runCatching { com.sunpride.field.sync.work.SyncWork.enqueue(context) }
        return sent
    }
    override fun queueDomain(kind:String,payload:JSONObject,aggregate:String,dependencies:List<String>):String{
        val partition=storedScope()?:error("Sync this account first")
        val life=sapMasterLifetime()?:error("Sign in again")
        val ticket=com.sunpride.field.sync.DomainOutbox.ticket()
        if(kind in setOf("jointcall.capture","collections.capture")) check(domainForms(kind.substringBefore("."),false)!=null) {"Refresh this authorized form before recording"}
        val row=com.sunpride.field.sync.DomainOutbox.intent(partition,kind,payload,aggregate,dependencies)
        withStore { store->store.enqueueDomain(row,System.currentTimeMillis()) {com.sunpride.field.sync.DomainOutbox.current(ticket)&&sapMasterLifetime()==life&&storedScope()==partition} }
        runCatching{com.sunpride.field.sync.work.SyncWork.enqueue(context)}
        return row.requestId
    }
    /** F-223/F-613 independently granted finite snapshots in the existing encrypted partition. */
    override fun domainForms(kind:String,refresh:Boolean):JSONObject? {
        require(kind in setOf("jointcall","collections"))
        val partition=storedScope()?:return null
        val day=LocalDate.now(ZoneId.of("Asia/Manila")).toString()
        val grant=projectionGrant("forms:$kind",day)?:return null
        val topic="field.$kind";val params=JSONObject().put("serviceDate",day)
        val store=EncryptedFieldDatabase.store(context,partition)
        fun refuse(){if(!grant.deny())auth.signOut()}
        return try{runBlocking{
            if(refresh)try{
                val me=functions.api.me()
                check(me.getJSONObject("profile").getBoolean("active")&&me.getJSONObject("device").getString("id")==partition.deviceId)
                check("v2:$environmentOrigin|${me.getJSONObject("profile").getString("subject")}"==partition.account&&me.getJSONObject("scope").getString("fingerprint")==partition.fingerprint)
                val response=functions.api.signed(com.sunpride.field.sync.V2Wire.PULL,com.sunpride.field.sync.V2Wire.pull(partition.deviceId,me.getJSONObject("scope").getString("id"),topic,params),loadSigner(),partition.deviceId)
                val b=com.sunpride.field.sync.V2Wire.bundle(response,me,topic,params)
                check(b.getBoolean("complete")&&!response.getBoolean("hasMore"))
                val data=b.getJSONObject("data")
                check(data.getString("profileId")==store.employeeId())
                val expires=minOf(b.getJSONObject("authorization").getLong("expiresAt"),b.getJSONObject("offlineLease").getLong("expiresAt"))
                check(expires>response.getLong("serverTime"))
                if(grant.current()&&storedScope()==partition){
                    val text=JSONObject().put("expiresAt",expires).put("data",data).toString()
                    grant.wrap(text)?.let{store.putLocalCache(domainFormsCacheEntity(topic),day,it,response.getLong("serverTime"),day)}
                }
            }catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;if(e !is AuthFailure||e.kind!=AuthFailure.Kind.OFFLINE)refuse()}
            if(!grant.current()||storedScope()!=partition||!store.isLeaseValid(System.currentTimeMillis()))return@runBlocking null
            val cache=store.localCache(domainFormsCacheEntity(topic),day)?.json?.let{grant.read(it)}?.let(::JSONObject)?:return@runBlocking null
            if(cache.getLong("expiresAt")<=System.currentTimeMillis())return@runBlocking null
            cache.getJSONObject("data").put("authorizationExpiresAt",cache.getLong("expiresAt")).put("localOperations",JSONArray().apply{for((row,out) in store.history().filter{it.first.kind=="$kind.capture"})put(JSONObject().put("requestId",row.requestId).put("aggregateId",row.clientVisitId).put("state",out.state).put("payload",JSONObject(row.serializedOperation).getJSONObject("payload")))})
        }}finally{store.close()}
    }
    private fun dsrToday(device:String,signer:DeviceSigner,me:JSONObject?,failure:Exception?=null,expectedKey:String?=sessionKey()):TodayData{
        val key=sessionKey()?:return TodayData(partnerMode=true)
        if(key!=expectedKey)return TodayData(partnerMode=true)
        val ticket=if(me!=null)com.sunpride.field.sync.DomainOutbox.begin()else com.sunpride.field.sync.DomainOutbox.ticket()
        val repo=com.sunpride.field.sync.DsrRepository(context,prefs,environmentOrigin,key,device,
            {sessionKey()==key&&com.sunpride.field.sync.DomainOutbox.current(ticket)},functions.api::get,
            {path,body->functions.api.signed(path,body,signer,device)})
        fun deny(e:Exception)=e !is AuthFailure||e.kind!=AuthFailure.Kind.OFFLINE
        fun refuse(){synchronized(com.sunpride.field.sync.DomainOutbox.authorizationLock){
            if(sessionKey()!=key||!com.sunpride.field.sync.DomainOutbox.current(ticket))return@synchronized
            com.sunpride.field.sync.DomainOutbox.deny(key)
            val saved=prefs.edit().putBoolean("$key.domainDenied",true).commit()
            val held=runCatching{runBlocking{EncryptedFieldDatabase.holdExisting(context)}}.isSuccess
            if(!saved||!held)runCatching{auth.signOut()}
        }}
        if(failure!=null&&deny(failure))refuse()
        return try{repo.load(me)}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;if(deny(e))refuse();repo.load(null).copy(stale=true,warning="Sync unavailable. Held or expired assignments cannot record.")}
    }
    private fun sessionKey(): String? = vault.readSession()?.let {
        MessageDigest.getInstance("SHA-256").digest(it.toByteArray(Charsets.UTF_8))
            .joinToString("") { b -> "%02x".format(b.toInt() and 255) }
    }
    private fun subjectFromToken(): String {
        val me = functions.api.me()
        check(me.getJSONObject("profile").getBoolean("active"))
        return "v2:${environmentOrigin}|${me.getJSONObject("profile").getString("subject")}"
    }
    override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData =
        today(deviceId, signer, sync, scheduleRemainder = true)

    fun today(deviceId: String, signer: DeviceSigner, sync: Boolean, scheduleRemainder: Boolean): TodayData {
        val key = sessionKey() ?: return TodayData()
        var subject = prefs.getString("$key.subject", null)
        var fingerprint = prefs.getString("$key.scope", null)
        var warning: String? = null
        var failed = prefs.getBoolean("$key.failed", true)
        val terminal = prefs.getInt("$key.updateVersion", -1) == com.sunpride.field.BuildConfig.VERSION_CODE
        if(!sync&&prefs.getBoolean("$key.partner",false))return dsrToday(deviceId,signer,null,expectedKey=key)
        if (sync && !terminal) {
            com.sunpride.field.diagnostics.SafeLog.event(context, "sync_started")
            try {
                val verifiedMe=functions.api.me()
                check(verifiedMe.getJSONObject("profile").getBoolean("active"))
                // NF-4: remember the verified person's name for the visit-photo watermark (snapshots made by an
                // older server carry no name in their employee header, and a delta sync never replaces that header).
                verifiedMe.getJSONObject("profile").let { p -> prefs.edit().putString("$key.personId", p.optString("id"))
                    .putString("$key.personName", p.optString("name").takeIf { it.isNotBlank() && it != "null" }).apply() }
                if(verifiedMe.getJSONObject("profile").getString("role")=="distributor"){
                    check(prefs.edit().putBoolean("$key.partner",true).commit())
                    return dsrToday(deviceId,signer,verifiedMe,expectedKey=key)
                }
                prefs.edit().putBoolean("$key.partner",false).apply()
                val authenticated = "v2:${environmentOrigin}|${verifiedMe.getJSONObject("profile").getString("subject")}"
                val existing = storedScope()?.takeIf { it.account == authenticated && it.deviceId == deviceId }
                val existingCursor = existing?.let { scope ->
                    val scoped = EncryptedFieldDatabase.store(context, scope)
                    try { runBlocking { if(scoped.workforceSnapshotCurrent()) scoped.cursor() else null } } finally { scoped.close() }
                }
                if (existing != null && existingCursor != null) {
                    val scoped = EncryptedFieldDatabase.store(context, existing)
                    try {
                        val gateway = com.sunpride.field.sync.SignedVisitGateway(visitTransport, signer, deviceId)
                        runBlocking {
                            com.sunpride.field.sync.VisitSync(gateway, scoped, existing, bootstrap = {
                                val page = BootstrapClient(syncTransport, signer, deviceId,
                                    { fp -> EncryptedFieldDatabase.store(context, StoreScope(authenticated, deviceId, fp)) })
                                    .fetch(subject = authenticated)
                                if (page.fingerprint != existing.fingerprint) {
                                    // Old partition stays held; new verified scope cannot adopt its operations.
                                    prefs.edit().putString("$key.scope", page.fingerprint).apply()
                                    fingerprint = page.fingerprint
                                    retireSuggestions()
                                }
                            }).sync()
                            val done=scoped.history().filter { com.sunpride.field.storage.WorkforceForms.isForm(it.first.kind)&&it.second.state=="done" }
                            if(done.any { scoped.visitPhotos(it.first.clientVisitId).any { p->p.photoType in com.sunpride.field.storage.WorkforceForms.PHOTO_TYPES } })
                                com.sunpride.field.evidence.EvidenceWork.enqueue(context)
                        }
                    } finally { scoped.close() }
                } else {
                    val p = BootstrapClient(syncTransport, signer, deviceId,
                        { fp -> EncryptedFieldDatabase.store(context, StoreScope(authenticated, deviceId, fp)) })
                        .fetch(subject = authenticated)
                    subject = authenticated; fingerprint = p.fingerprint
                    prefs.edit().putString("$key.subject", subject).putString("$key.scope", fingerprint)
                        .putString("$key.device", deviceId).apply()
                }
                val healthScope = storedScope()
                if(healthScope!=null&&healthScope.fingerprint==verifiedMe.getJSONObject("scope").getString("fingerprint")) {
                    val ticket=com.sunpride.field.sync.DomainOutbox.ticket()
                    val scoped=EncryptedFieldDatabase.store(context,healthScope)
                    try { runBlocking { com.sunpride.field.sync.DomainOutbox.sync(scoped,healthScope,verifiedMe.getJSONObject("scope").getString("id"),
                        {sessionKey()==key&&storedScope()==healthScope&&com.sunpride.field.sync.DomainOutbox.current(ticket)},
                        {path,body->functions.api.signed(path,body,signer,deviceId)}) } } finally {scoped.close()}
                }
                val health = healthScope?.let { scope ->
                    val scoped = EncryptedFieldDatabase.store(context, scope)
                    try { runBlocking { scoped.syncHealth() } } finally { scoped.close() }
                }
                failed = health != "synced"
                if(!failed) runCatching {sapMasters(true)} // F-004: independent authorized master cursor, no parallel selling book.
                com.sunpride.field.diagnostics.SafeLog.event(context, if (failed) "sync_retry" else "sync_complete")
                prefs.edit().putBoolean("$key.failed", failed).apply()
            } catch (e: Exception) {
                com.sunpride.field.diagnostics.SafeLog.event(context, "sync_retry")
                // FLD-171: the server ended this session; the controller returns to sign-in with the reason.
                if (e is AuthFailure && e.kind == AuthFailure.Kind.SESSION_EXPIRED) throw e
                if(prefs.getBoolean("$key.partner",false))return dsrToday(deviceId,signer,null,e,expectedKey=key)
                failed = true
                prefs.edit().putBoolean("$key.failed", true).apply()
                warning = when (e) {
                    is BootstrapFailure -> when (e.kind) {
                        BootstrapFailure.Kind.REMOVED -> "Phone removed"
                        BootstrapFailure.Kind.UPDATE_REQUIRED -> "Update required"
                        BootstrapFailure.Kind.UNAUTHORIZED -> "Sign in again"
                        else -> "Sync unavailable — showing saved visits"
                    }
                    else -> "Sync unavailable — showing saved visits"
                }
                if (e is BootstrapFailure && e.kind == BootstrapFailure.Kind.UNAUTHORIZED) {
                    // HTTP gateway returns 401 for failed device authorization, including revocation.
                    // Distinguish it by a fresh authenticated enrollment read when possible.
                    val revoked = runCatching { ServerDeviceApi(functions).mine(signer.publicKeyBase64)?.status }
                        .getOrNull() in setOf("revoked", "suspended")
                    if (revoked) warning = "Phone removed"
                }
                if (warning == "Update required") prefs.edit()
                    .putInt("$key.updateVersion", com.sunpride.field.BuildConfig.VERSION_CODE).apply()
                if (warning == "Phone removed") {
                    // QSR-010: confirmed revocation/suspension drops cached plan, customers and prices.
                    retireSuggestions()
                    runBlocking { EncryptedFieldDatabase.purgeExisting(context) }
                } else if (e is BootstrapFailure && e.kind == BootstrapFailure.Kind.UNAUTHORIZED) {
                    retireSuggestions()
                    runBlocking { EncryptedFieldDatabase.holdExisting(context) }
                }
            }
            observeSuggestionScope(storedScope())
        }
        if (subject == null || fingerprint == null || prefs.getString("$key.device", null) != deviceId)
            return TodayData(warning = warning ?: if (terminal) "Update required" else null, updateRequired = terminal)
        val db = EncryptedFieldDatabase.shared(context)
        val store = EncryptedFieldDatabase.store(context, StoreScope(subject, deviceId, fingerprint))
        return runBlocking {
            val day = LocalDate.now(ZoneId.of("Asia/Manila")).toString()
            val outletRows = store.outlets().associate { it.id to JSONObject(it.json) }
            val outlets = outletRows.mapValues { it.value.optString("name", "Outlet") }
            val customers = store.customers().associate { it.id to JSONObject(it.json).optString("code") }
            val visits = store.todaysVisits(day).map { row -> plannedVisitDisplay(row, outletRows, customers) }
            val history = store.history()
            val decorated = visits.map { visit ->
                val own = history.filter { (intent, _) ->
                    val op = JSONObject(intent.serializedOperation)
                    val payload = op.getJSONObject("payload")
                    intent.kind == "visit.checkIn" && payload.optString("outletId") == visit.outletId &&
                        payload.optString("serviceDate") == day && payload.optString("plannedVisitId") == visit.plannedVisitId
                }.map { it.first.clientVisitId }.toSet()
                val related = history.filter { it.first.clientVisitId in own }
                val call = related.map { it.first to it.second.state }
                visit.copy(status = when {
                    related.any { it.second.state == "review" } -> "Needs review"
                    VisitCallRules.closed(call) -> "Done"
                    VisitCallRules.started(call) -> "In progress"
                    else -> visit.status
                }, timeSpent = VisitCallRules.timeSpent(call),
                    callFacts = com.sunpride.field.storage.ProductiveCall.factsOf(call))
            }
            val directory = com.sunpride.field.ui.customers.CustomerDirectory.build(store.outlets(), customers,
                store.plannedVisits(), store.route(),
                outletRows.keys.mapNotNull { id -> store.callSheet(id)?.let { id to it.header } }.toMap(),
                history.map { it.first to it.second.state }, decorated)
            val tasks = store.tasks().mapNotNull { row ->
                runCatching { JSONObject(row.json) }.getOrNull()?.let {
                    com.sunpride.field.ui.customers.CustomerTask(it.optString("kind"), it.optBoolean("required"))
                }?.takeIf { it.kind.isNotBlank() }
            }
            val held = db.rows().heldCount(subject, deviceId)
            val result = TodayData(decorated, store.status().lastSuccess,
                failed || held > 0 || !store.isLeaseValid(System.currentTimeMillis()) || history.any { it.second.state != "done" } ||
                    store.syncHealth() != "synced",
                warning ?: if (held > 0) "Prior assignment has held visit work — administrator review required"
                    else if (terminal) "Update required" else null,
                terminal || warning == "Update required",
                history.count { it.second.state == "review" } + held, history.count { it.second.state == "pending" },
                outlets.map { (id, name) -> VisitDisplay(name, "Unplanned", "Reason required", id) },
                store.status(), directory, tasks,
                com.sunpride.field.ui.team.TeamRepository.offered(store.employeeRole()),
                routeCode = store.routeCode(), sales = daySales(store, day, sync),targets=targetProgress(store,day,sync))
            if (scheduleRemainder && sync && result.syncStatus.queued + result.syncStatus.sending > 0 &&
                result.syncStatus.held == 0 && result.syncStatus.health != "held_for_review")
                com.sunpride.field.sync.work.SyncWork.enqueue(context)
            // AND-016: a sync may have just delivered the Start ack that photos were waiting for.
            if (sync && result.syncStatus.photosWaiting > 0 && result.syncStatus.health != "held_for_review")
                runCatching { com.sunpride.field.evidence.EvidenceWork.enqueue(context) }
            result
        }
    }
    /** F-615 signed own-person read, encrypted same-partition cache and independent report grant. */
    private suspend fun targetProgress(store:RoomFieldStore,day:String,live:Boolean):com.sunpride.catalogue.TargetProgressView {
        val grant=projectionGrant("targets",day)?:return com.sunpride.catalogue.TargetProgressView(message="Sign in and sync to see targets")
        val cache=object:com.sunpride.catalogue.TargetProgressCache {
            override fun current()=grant.current()
            override fun revoke(){if(!grant.deny())auth.signOut()}
            override fun read(day:String)=runBlocking{store.localCache("local.targets",day)}?.let{r->r.json?.let{grant.read(it)?.let{raw->raw to r.revision}}}
            override fun write(day:String,text:String,at:Long){val wrapped=checkNotNull(grant.wrap(text));runBlocking{store.putLocalCache("local.targets",day,wrapped,at,day)}}
        }
        val personId=store.employeeId()
        val fetch:(()->String)?=if(!live)null else ({
            val text=functions.query(com.sunpride.catalogue.TargetProgressCodec.PATH,JSONObject().put("serviceDate",day)).toString()
            if(JSONObject(text).getString("profileId")!=personId){cache.revoke();error("Targets belong to another verified profile")};text
        })
        return com.sunpride.catalogue.TargetProgressRepository.load(day,cache,System.currentTimeMillis(),fetch){e->e is ServerError||e is AuthFailure&&e.kind==AuthFailure.Kind.SESSION_EXPIRED}
    }
    /** Live daily sales report when syncing, else today's saved copy; the server enforces who may read it. */
    private suspend fun daySales(store: RoomFieldStore, day: String, live: Boolean): com.sunpride.field.ui.today.DaySalesView {
        val grant = projectionGrant("sales", day) ?: return com.sunpride.field.ui.today.DaySalesView(
            message = "Sign in again to see sales")
        val cache = object : com.sunpride.field.ui.today.DaySalesCache {
            override fun current() = grant.current()
            override fun revoke() { if (!grant.deny()) auth.signOut() }
            override fun read(key: String) = runBlocking { store.localCache(SALES_CACHE, key) }
                ?.let { row -> row.json?.let { grant.read(it)?.let { text -> text to row.revision } } }
            override fun write(key: String, json: String, savedAt: Long) {
                grant.wrap(json)?.let { runBlocking { store.putLocalCache(SALES_CACHE, key, it, savedAt, day) } }
            }
        }
        val profileId = store.employeeId()
        val fetch: (() -> String)? = if (!live || profileId == null) null else ({
            val value = functions.query(com.sunpride.field.ui.today.DaySalesCodec.PATH,
                com.sunpride.field.ui.today.DaySalesCodec.args(profileId, day))
            (value as? JSONObject)?.toString() ?: throw com.sunpride.field.ui.today.DaySalesWireFailure()
        })
        return com.sunpride.field.ui.today.DaySalesRepository.load(day, cache, System.currentTimeMillis(), fetch)
    }
    override fun team(directOnly: Boolean): com.sunpride.field.ui.team.TeamView {
        val scope = storedScope() ?: return com.sunpride.field.ui.team.TeamView(message = "Sync first to see your team.")
        val day = LocalDate.now(ZoneId.of("Asia/Manila")).toString()
        val store = EncryptedFieldDatabase.store(context, scope)
        try {
            val grant = projectionGrant("team", com.sunpride.field.ui.team.TeamRepository.key(day, directOnly))
                ?: return com.sunpride.field.ui.team.TeamView(message = "Sign in again to see your team.")
            val cache = object : com.sunpride.field.ui.team.TeamCache {
                override fun current() = grant.current()
            override fun revoke() { if (!grant.deny()) auth.signOut() }
                override fun read(key: String) = runBlocking { store.localCache(TEAM_CACHE, key) }
                    ?.let { row -> row.json?.let { grant.read(it)?.let { text -> text to row.revision } } }
                override fun write(key: String, json: String, savedAt: Long) {
                    grant.wrap(json)?.let { runBlocking { store.putLocalCache(TEAM_CACHE, key, it, savedAt, "$day|") } }
                }
            }
            return com.sunpride.field.ui.team.TeamRepository.load(day, directOnly, cache, System.currentTimeMillis()) {
                val value = functions.query(com.sunpride.field.ui.team.TeamCodec.PATH,
                    com.sunpride.field.ui.team.TeamCodec.args(day, directOnly))
                (value as? JSONObject)?.toString() ?: throw com.sunpride.field.ui.team.TeamWireFailure()
            }
        } finally { store.close() }
    }
    override fun suggestedOrder(outletId: String): com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView {
        val repo = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository
        val scope = storedScope() ?: return com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(message = repo.CONNECTION)
        val day = LocalDate.now(ZoneId.of("Asia/Manila")).toString()
        observeSuggestionScope(scope)
        val store = EncryptedFieldDatabase.store(context, scope)
        try {
            val cache = com.sunpride.field.ui.diagnosticvisit.StoreSuggestedOrderCache(store, day)
            return repo.load(outletId, day, cache, System.currentTimeMillis()) {
                val value = functions.query(com.sunpride.field.ui.diagnosticvisit.SuggestedOrderCodec.PATH,
                    com.sunpride.field.ui.diagnosticvisit.SuggestedOrderCodec.args(outletId, day))
                (value as? JSONObject)?.toString() ?: throw com.sunpride.field.ui.diagnosticvisit.SuggestedOrderWireFailure()
            }
        } finally { store.close() }
    }
    /** Verified scope the suggested-order lifetime belongs to; any change (A → B, or back to A) retires it. */
    private var suggestionScope: StoreScope? = null
    private fun observeSuggestionScope(scope: StoreScope?) = synchronized(this) {
        if (scope != suggestionScope) { suggestionScope = scope; retireSuggestions() }
    }
    private fun retireSuggestions() {
        com.sunpride.field.sync.DomainOutbox.retire()
        com.sunpride.field.auth.ProjectionGrant.retire()
        com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.retire()
    }
    private fun projectionGrant(name: String, filter: String): com.sunpride.field.auth.ProjectionGrant? {
        val key = sessionKey() ?: return null
        val scope = storedScope() ?: return null
        if (key != sessionKey()) return null
        val grants = context.getSharedPreferences("field_v2_projection_grants", Context.MODE_PRIVATE)
        return com.sunpride.field.auth.ProjectionGrant("${scope}|$key", name,
            { grants.getString(it, null) }, { k, v -> grants.edit().putString(k, v).commit() }).also { it.begin(filter) }
    }
    /** SP-0136: the signed-in person's verified account (keys their consent and work day), or null. */
    fun locationAccount(): String? = storedScope()?.account
    override val workDay: com.sunpride.field.location.WorkDayHost by lazy {
        val local = com.sunpride.field.location.LocationShare.workDay(context) { locationAccount() }
        object : com.sunpride.field.location.WorkDayHost by local {
            override fun consent(now: Long) {
                local.consent(now)
                prefs.edit().putBoolean("${sessionKey()}.location-consent-pending", true).apply()
                locationCommands()
            }
            override fun startDay(now: Long) {
                local.startDay(now)
                prefs.edit().putLong("${sessionKey()}.location-start-pending", now)
                    .remove("${sessionKey()}.location-end-pending").commit()
                locationCommands()
            }
            override fun endDay(now: Long) {
                local.endDay(now)
                prefs.edit().remove("${sessionKey()}.location-start-pending")
                    .putBoolean("${sessionKey()}.location-end-pending", true).apply()
                locationCommands()
            }
        }
    }
    private fun locationCommands() {
        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
            runCatching { flushLocationCommands() }
        }
    }
    @Synchronized private fun flushLocationCommands() {
        if (prefs.getBoolean("${sessionKey()}.location-consent-pending", false)) {
            functions.api.post("/api/v1/location/consent", JSONObject().put("enabled", true))
            prefs.edit().remove("${sessionKey()}.location-consent-pending").commit()
        }
        val startedAt = prefs.getLong("${sessionKey()}.location-start-pending", 0L)
        if (startedAt > 0) {
            functions.api.post("/api/v1/location/consent", JSONObject().put("enabled", true)
                .put("startDay", true).put("startedAt", startedAt))
            prefs.edit().remove("${sessionKey()}.location-start-pending").commit()
        }
        if (prefs.getBoolean("${sessionKey()}.location-end-pending", false)) {
            functions.api.post("/api/v1/location/end-day", JSONObject())
            prefs.edit().remove("${sessionKey()}.location-end-pending").commit()
        }
    }
    /** Buffer one live-map ping in the encrypted store; false when there is no usable partition. */
    fun recordLocation(fix: com.sunpride.field.location.Fix, trigger: String, battery: Int?, now: Long): Boolean {
        val scope = storedScope() ?: return false
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking {
            val open = com.sunpride.field.location.OpenVisit.checkInRequestId(store.history().map { it.first to it.second.state })
            val visitId = com.sunpride.field.location.OpenVisit.serverId(open?.let { store.ack(it)?.entityId })
            val ping = com.sunpride.field.location.PingCodec.ping(fix, trigger, battery, visitId)
            store.addPing(ping.getString("clientPingId"), fix.time, ping.toString(), now)
        } } finally { store.close() }
    }
    /** Upload buffered pings through the signed device gateway (`/api/sync/push`, `location.record`). */
    fun uploadLocation(): com.sunpride.field.location.PingUpload {
        flushLocationCommands()
        val scope = storedScope() ?: return com.sunpride.field.location.PingUpload()
        val device = vault.deviceId?.takeIf { it == scope.deviceId } ?: return com.sunpride.field.location.PingUpload()
        val gateway = com.sunpride.field.sync.SignedVisitGateway(visitTransport, loadSigner(), device)
        val store = EncryptedFieldDatabase.store(context, scope)
        return try { runBlocking {
            com.sunpride.field.location.LocationUploader(store, device) { path, bytes -> gateway.post(path, bytes) }.run()
        } } finally { store.close() }
    }
    override val cachedDeviceId get() = vault.deviceId
    override val isSignedIn get() = auth.isSignedIn
    override fun loadSigner() = signerLoader()
    override fun queueMockRefusal(outletId: String) {
        val identity=storedScope() ?: error("No verified local partition")
        val at=System.currentTimeMillis()
        withStore {store ->
            check(store.outlets().any {it.id==outletId}) {"Outlet is not in the authorized snapshot"}
            store.enqueue(com.sunpride.field.storage.MockAttempts.create(identity,outletId,at),at)
        }
        schedulePendingWork()
    }
    override fun sapMasters(refresh: Boolean): JSONObject? {
        val identity=storedScope() ?: return null
        val session= sessionKey() ?: return null
        val epoch=authorizationEpoch
        val key=com.sunpride.field.device.RequestSigner.bodyDigest("$session|${identity.account}|${identity.deviceId}|${identity.fingerprint}".toByteArray())
        val store=EncryptedFieldDatabase.store(context,identity)
        val access=com.sunpride.catalogue.SapMasterAccess(context)
        val current={session==sessionKey() && identity==storedScope() && epoch==authorizationEpoch && auth.isSignedIn && runBlocking {store.isLeaseValid(System.currentTimeMillis())}}
        val read={runBlocking {store.localCache("local.sap.masters",key)?.takeUnless {it.tombstone}?.json}}
        try {
            fun display(state:JSONObject?):JSONObject?=state?.put("authorizationExpiresAt",runBlocking {store.masterReadUntil()})
            if(!refresh)return display(access.cached(key,read,current))
            val binding=com.sunpride.catalogue.SapMasterMirror.Binding("field-android",identity.deviceId,runBlocking {store.masterScopeId()},identity.fingerprint)
            return display(access.refresh(key,binding,read,{json->runBlocking {
                check(current());store.putLocalCache("local.sap.masters",key,json,System.currentTimeMillis(),key)
            }},{request->functions.api.signed("/api/sync/pull",request,signerLoader(),identity.deviceId)},current,
                {e->e !is AuthFailure || e.kind!=AuthFailure.Kind.OFFLINE}))
        }finally{store.close()}
    }
    override fun creditControl(action:String,args:JSONObject):JSONObject {
        val before=sapMasterLifetime();check(before!=null){"Sign in and sync before checking credit"}
        val result=when(action){
            "list"->functions.api.get("/api/v1/credit/control")
            "exposure"->functions.api.get("/api/v1/credit/exposure?customerCode="+java.net.URLEncoder.encode(args.getString("customerCode"),"UTF-8")+"&outletId="+java.net.URLEncoder.encode(args.optString("outletId"),"UTF-8")+"&orderId="+java.net.URLEncoder.encode(args.getString("orderId"),"UTF-8"))
            "request"->functions.api.post("/api/v1/credit/request-override",args)
            "status"->functions.api.post("/api/v1/credit/exception/status",args)
            else->error("Unsupported credit action")
        }
        check(before==sapMasterLifetime()){"The account changed"};return result
    }
    override fun sapMasterLifetime(): String? = if(auth.isSignedIn) "${sessionKey()}|${storedScope()}|$authorizationEpoch" else null
    override fun appUpdates() = com.sunpride.integrity.AppUpdateClient(context,environmentOrigin,token={refresh->auth.accessToken(refresh)})
    override fun signIn(email: String, password: String) = auth.signIn(email, password)
    override fun companySignIn(tokens: JSONObject) = auth.acceptCompanySession(tokens)
    override fun replacementCode(): JSONObject = functions.api.post("/api/v1/integrity/devices/pairing/start",
        signerLoader().let { signer -> com.sunpride.integrity.replacementPairingBody("field-android",
            JSONObject().put("keyId",com.sunpride.field.device.RequestSigner.bodyDigest(signer.publicKeySpki)).put("publicKeySpki",signer.publicKeyBase64),signer::sign) })
    override fun changePassword(current: String, next: String, confirm: String) = auth.changePassword(current, next, confirm)
    override fun signOut() {
        // SP-0136: sharing stops before anything else (the account key is still readable here).
        runCatching { workDay.signOut(System.currentTimeMillis()) }
        signOutNow()
    }
    private fun signOutNow(): Unit {
        // SP-0148: chat stops polling/sending and its saved messages, outbox and pictures go with the session.
        runCatching { com.sunpride.field.chat.FieldChat.signOut(context) }
        retireSuggestions()
        signOutTeardown(
        // QSR-010: sign-out leaves only held, encrypted unsent evidence; no cached plan, customers,
        // prices or session-keyed scope index survive for the next person on this phone.
        // Suggested-order authorization ends before the purge, which can fail (SP-0067).
        purgeCache = {
            com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.endSession {
                runBlocking { EncryptedFieldDatabase.purgeExisting(context) }
            }
        },
        clearIndex = {
            val cleared = context.getSharedPreferences("field_v2_projection_grants", Context.MODE_PRIVATE).edit().clear().commit()
            if (!prefs.edit().clear().commit() || !cleared) throw SessionStorageFailure()
        },
        authSignOut = { auth.signOut() },
    )
    }
    override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState {
        val state = try {
            Enrollment(ServerDeviceApi(functions), signer, vault).refresh()
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) {
                retireSuggestions()
                runBlocking { EncryptedFieldDatabase.holdExisting(context) }
            }
            throw e
        }
        if (state !is EnrollmentState.Ready) retireSuggestions()
        if (state == EnrollmentState.Removed) runBlocking { EncryptedFieldDatabase.purgeExisting(context) }
        else if (state == EnrollmentState.Unregistered) runBlocking { EncryptedFieldDatabase.holdExisting(context) }
        return state
    }
}

/** Non-secret key facts shown on the enrollment screen and in diagnostics. */
data class DeviceKeyInfo(val publicKey: String, val fingerprint: String, val protection: String)

class FieldController(
    private val backend: FieldBackend,
    private val scope: CoroutineScope,
    val io: CoroutineDispatcher = Dispatchers.IO,
    /** Compose state is only written here (main thread in the app; tests may pass EmptyCoroutineContext). */
    private val ui: CoroutineContext = Dispatchers.Main.immediate,
    private val now: () -> Long = System::currentTimeMillis,
    private val onKeyLoaded: (DeviceKeyInfo) -> Unit = {}
) {
    var state by mutableStateOf<EnrollmentState>(EnrollmentState.SignedOut); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var key by mutableStateOf<DeviceKeyInfo?>(null); private set
    var today by mutableStateOf(TodayData()); private set
    var workforceOpen by mutableStateOf(false); private set
    private var workforceData by mutableStateOf(com.sunpride.field.storage.WorkforceView())
    // Snapshot state, and read BEFORE the guard: a short-circuited read would leave the screen
    // unsubscribed, so a later load (offline cold start included) would never recompose it.
    private var workforceEpoch by mutableStateOf(Long.MIN_VALUE)
    val workforceLifetime: Long get()=backend.authorizationEpoch
    val workforce: com.sunpride.field.storage.WorkforceView get() {
        val data=workforceData;val loadedIn=workforceEpoch
        return if(state is EnrollmentState.Ready && loadedIn==backend.authorizationEpoch)data else com.sunpride.field.storage.WorkforceView()
    }
    private var workforceLoading=false
    fun openWorkforce() {workforceOpen=true;error=null;reloadWorkforce()}
    fun reloadWorkforce()=scope.launch(ui) {
        if(workforceLoading)return@launch
        workforceLoading=true
        try {
            val epoch=backend.authorizationEpoch
            val data=withContext(io) { backend.workforceView() }
            if(state is EnrollmentState.Ready && epoch==backend.authorizationEpoch) {workforceData=data;workforceEpoch=epoch}
        } catch(e: kotlinx.coroutines.CancellationException) {throw e}
        catch(_: Exception) {workforceData=com.sunpride.field.storage.WorkforceView();error="Field forms need a refresh or office configuration."}
        finally {workforceLoading=false}
    }
    fun closeWorkforce() { workforceOpen=false;error=null }
    fun saveWorkforce(kind: String,name: String,answers: Map<String,String>,geo: JSONObject?,jpeg: ByteArray?,photoAt: Long,onSaved: () -> Unit)=scope.launch(ui) {
        if(busy)return@launch
        busy=true;error=null
        val epoch=backend.authorizationEpoch
        try {
            withContext(io) { backend.queueWorkforce(kind,name,answers,geo,jpeg,photoAt) }
            if(state !is EnrollmentState.Ready || epoch!=backend.authorizationEpoch)return@launch
            workforceData=withContext(io) { backend.workforceView() };workforceEpoch=epoch
            onSaved();loadToday(sync=false)
        } catch(e: kotlinx.coroutines.CancellationException) {throw e}
        catch(_: Exception) {error="Could not save. Check required fields, a recent photo and location, then try again."}
        finally {busy=false}
    }
    var diagnostic by mutableStateOf<VisitDisplay?>(null); private set
    var diagnosticRows by mutableStateOf<List<Pair<com.sunpride.field.storage.IntentRow, String>>>(emptyList()); private set
    var diagnosticError by mutableStateOf<String?>(null); private set
    var retailCall by mutableStateOf<com.sunpride.retail.RetailCall?>(null); private set
    val retailSaved: Boolean get() = diagnostic?.let { v -> relatedCall(v).firstOrNull { it.first.kind=="visit.checkIn" }?.first?.clientVisitId }?.let { com.sunpride.field.storage.RetailQueueRules.saved(it,diagnosticRows) } ?: false
    var diagnosticCallSheet by mutableStateOf<CallSheet?>(null); private set
    var diagnosticOrderTerms by mutableStateOf<OrderTerms?>(null); private set
    var callSheetOpen by mutableStateOf(false); private set
    /** Order drafts that belong to this visit's calls (local only, SP-0061). */
    var visitOrderDrafts by mutableStateOf<List<OrderDraft>>(emptyList()); private set
    var orderOpen by mutableStateOf(false); private set
    /** Draft being edited; null while composing a new one (set after its first save). */
    var orderDraftId by mutableStateOf<String?>(null); private set
    val openOrderDraft: OrderDraft? get() = orderDraftId?.let { id -> visitOrderDrafts.firstOrNull { it.draftId == id } }
    fun saveRetail(answers: List<com.sunpride.retail.ShelfAnswer>, quantities: Map<String,Long>) = scope.launch(ui) {
        val visit=diagnostic ?: return@launch
        val call=retailCall ?: return@launch
        if(busy)return@launch
        busy=true;diagnosticError=null
        try {
            refreshDiagnostic()
            val start=openCheckIn(visit) ?: error("Start the call first")
            val previous=relatedCall(visit).lastOrNull()?.first?.requestId ?: start.requestId
            val saved=withContext(io) {backend.saveRetail(call,start.clientVisitId,start.requestId,previous,answers,quantities)}
            refreshDiagnostic()
            if(saved!=null){orderDraftId=saved.draftId;orderOpen=true}
        }catch(e:kotlinx.coroutines.CancellationException){throw e}
        catch(_:Exception){diagnosticError="Could not save availability or prepare the order. Check every MSL line and use whole selling quantities."}
        finally{busy=false}
    }
    fun openCallSheet() = scope.launch(ui) {
        callSheetOpen = true; diagnosticError = null; endReview = null
        diagnosticCallSheet?.outletId?.let { loadSuggestedOrder(it) }
    }
    /** ANA-010 suggested order for the open call sheet; only ever fills local Order fields. */
    var suggestedOrder by mutableStateOf(com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView()); private set
    private var suggestedOrderFor: String? = null
    /** Bumped by every load, close, sign-out and lifetime change: only the newest request may publish its answer. */
    private var suggestedOrderRequest = 0L
    /** Authorization epoch the shown (or loading) suggestion belongs to. */
    private var suggestedOrderEpoch: Long? = null
    fun loadSuggestedOrder(outletId: String) = scope.launch(ui) {
        if (state !is EnrollmentState.Ready || (suggestedOrder.loading && suggestedOrderFor == outletId)) return@launch
        val request = ++suggestedOrderRequest
        val epoch = backend.authorizationEpoch
        suggestedOrderFor = outletId; suggestedOrderEpoch = epoch
        suggestedOrder = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(loading = true,
            message = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.LOADING)
        val result = try { withContext(io) { backend.suggestedOrder(outletId) } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(
                message = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.CONNECTION) }
        // A newer request (same or another store), a closed sheet or sign-out overtook this one: drop it.
        // Matching the store alone is not enough — A → B → A would let the first A answer undo a newer refusal.
        // Nor is an equal scope: the answer must come from the same, still-current authorization lifetime.
        if (request != suggestedOrderRequest) return@launch
        if (state is EnrollmentState.Ready && backend.authorizationEpoch == epoch) suggestedOrder = result
        else retireSuggestedOrder()
    }
    /** Scope, session or enrollment changed: drop the shown suggestion and any answer still in flight. */
    private fun retireSuggestedOrder() {
        suggestedOrderRequest++
        suggestedOrder = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView()
        suggestedOrderFor = null; suggestedOrderEpoch = null
    }
    private fun checkSuggestedOrderLifetime() {
        val epoch = suggestedOrderEpoch ?: return
        if (state !is EnrollmentState.Ready || backend.authorizationEpoch != epoch) retireSuggestedOrder()
    }
    fun closeCallSheet() = scope.launch(ui) {
        callSheetOpen = false; diagnosticError = null
        runCatching { backend.abandonSuggestedOrders() }
        retireSuggestedOrder()
    }
    /** AND-013: downloaded activity-form rules, the open form, and an unplanned visit's chosen purposes. */
    var diagnosticRules by mutableStateOf<List<com.sunpride.field.storage.ActivityRule>>(emptyList()); private set
    var activityForm by mutableStateOf<String?>(null); private set
    var selectedIntents by mutableStateOf<List<String>>(emptyList()); private set
    fun openActivityForm(kind: String) = scope.launch(ui) { activityForm = kind; diagnosticError = null; endReview = null }
    /** AND-016: configured photo types, the open visit's saved photos, and the camera screen. */
    var diagnosticPhotoTypes by mutableStateOf<List<com.sunpride.field.storage.PhotoType>>(emptyList()); private set
    var diagnosticPhotos by mutableStateOf<List<com.sunpride.field.storage.VisitPhoto>>(emptyList()); private set
    var photoCaptureOpen by mutableStateOf(false); private set
    fun openPhotoCapture() = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        diagnosticError = null; diagnosticFailure = null; endReview = null
        val checkin = openCheckIn(visit)
        when {
            checkin == null -> { diagnosticFailure = VisitRuleFailure.Code.CALL_NOT_OPEN; diagnosticError = VisitRuleFailure.Code.CALL_NOT_OPEN.text }
            diagnosticRows.any { it.first.clientVisitId == checkin.clientVisitId && it.first.kind == "visit.checkOut" } -> {
                diagnosticFailure = VisitRuleFailure.Code.ALREADY_ENDED; diagnosticError = VisitRuleFailure.Code.ALREADY_ENDED.text }
            else -> photoCaptureOpen = true
        }
    }
    fun closePhotoCapture() = scope.launch(ui) { photoCaptureOpen = false; diagnosticError = null }
    /** Types this phone offers: the downloaded list, or the provisional defaults. */
    fun photoTypeChoices(): List<com.sunpride.field.storage.PhotoType> =
        com.sunpride.field.storage.EvidencePhotos.offered(diagnosticPhotoTypes)
    /** Save one captured JPEG for the open call. Never needs a network; upload follows on its own. */
    fun savePhoto(photoType: String, jpeg: ByteArray, capturedAt: Long, onSaved: () -> Unit = {}) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null; diagnosticFailure = null
        try {
            refreshDiagnostic()
            if (photoTypeChoices().none { it.code == photoType }) throw IllegalArgumentException("type")
            val checkin = openCheckIn(visit) ?: throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
            if (diagnosticRows.any { it.first.clientVisitId == checkin.clientVisitId && it.first.kind == "visit.checkOut" })
                throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_ENDED)
            withContext(io) { backend.savePhoto(checkin.clientVisitId, checkin.requestId, visit.outletId, photoType, jpeg, capturedAt) }
            photoCaptureOpen = false
            onSaved()
            refreshDiagnostic(); loadToday(sync = false)
        } catch (e: VisitRuleFailure) { diagnosticFailure = e.code; diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) {
            com.sunpride.field.diagnostics.SafeLog.failure(null, "photo_save_failed", e)
            diagnosticError = com.sunpride.field.storage.PhotoFailureText.of(e)
        }
        finally { busy = false }
    }
    fun closeActivityForm() = scope.launch(ui) { activityForm = null; diagnosticError = null }
    fun toggleIntent(intent: String) = scope.launch(ui) {
        if (intent !in com.sunpride.field.storage.ActivityRules.INTENTS) return@launch
        selectedIntents = if (intent in selectedIntents) selectedIntents - intent
            else com.sunpride.field.storage.ActivityRules.INTENTS.filter { it in selectedIntents || it == intent }
    }
    /** SP-0060: review step of the open draft, and its locally checked rules. */
    var orderReview by mutableStateOf(false); private set
    var orderChecks by mutableStateOf<List<com.sunpride.field.orders.OrderCheck>>(emptyList()); private set
    /** A sent order opens straight to its read-only review/status. */
    fun openOrder(draftId: String? = null) = scope.launch(ui) {
        orderOpen = true; orderDraftId = draftId; diagnosticError = null; endReview = null
        orderReview = draftId != null && visitOrderDrafts.firstOrNull { it.draftId == draftId }?.submittedRequestId != null
        if (orderReview) loadOrderChecks()
    }
    fun closeOrder() = scope.launch(ui) {
        orderOpen = false; orderDraftId = null; orderReview = false; orderChecks = emptyList(); diagnosticError = null
    }
    fun openOrderReview() = scope.launch(ui) {
        if (orderDraftId == null) return@launch
        orderReview = true; diagnosticError = null; loadOrderChecks()
    }
    fun closeOrderReview() = scope.launch(ui) {
        orderReview = false; orderChecks = emptyList(); diagnosticError = null
        // A sent order has no editor to go back to.
        if (openOrderDraft?.submittedRequestId != null) { orderOpen = false; orderDraftId = null }
    }
    private suspend fun loadOrderChecks() {
        val id = orderDraftId ?: return
        orderChecks = runCatching { withContext(io) { backend.orderChecks(id) } }.getOrDefault(emptyList())
    }
    /** What the person sees about a draft's journey to the office (outbox state). */
    fun orderStatus(draft: OrderDraft) = com.sunpride.field.orders.OrderSubmission.status(draft, diagnosticRows)
    /** Submit the reviewed draft: queue its order request behind the call's latest request. */
    fun submitOrder() = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        val id = orderDraftId ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null
        try {
            refreshDiagnostic() // Re-read before enforcing, never trust a stale screen projection.
            val draft = visitOrderDrafts.firstOrNull { it.draftId == id } ?: throw OrderDraftFailure(OrderDraftFailure.Code.CALL_NOT_OPEN)
            if (draft.submittedRequestId != null) throw OrderDraftFailure(OrderDraftFailure.Code.SUBMITTED)
            val related = diagnosticRows.filter { it.first.clientVisitId == draft.clientVisitId }
            if (related.any { it.first.kind == "visit.checkOut" }) throw OrderDraftFailure(OrderDraftFailure.Code.CALL_ENDED)
            val previous = related.lastOrNull()?.first?.requestId ?: throw OrderDraftFailure(OrderDraftFailure.Code.CALL_NOT_OPEN)
            withContext(io) { backend.submitOrderDraft(id, previous) }
            refreshDiagnostic(); loadToday(sync = false)
        } catch (e: OrderDraftFailure) { diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { diagnosticError = "Could not send the order. Check the lines and try again." }
        finally {
            busy = false
            if (diagnostic == visit) loadOrderChecks()
        }
    }
    /** FLD-084: set when this visit's Start or End was refused outside the radius; shows the approval request. */
    var outsideRadius by mutableStateOf(false); private set
    fun openDiagnostic(visit: VisitDisplay) = scope.launch(ui) {
        diagnostic = visit; diagnosticError = null; diagnosticFailure = null; outsideRadius = false
        callSheetOpen = false; diagnosticCallSheet = null; diagnosticOrderTerms = null; activityForm = null; selectedIntents = emptyList()
        orderOpen = false; orderDraftId = null; visitOrderDrafts = emptyList(); orderReview = false; orderChecks = emptyList()
        endReview = null; photoCaptureOpen = false; diagnosticPhotos = emptyList()
        refreshDiagnostic()
    }
    var diagnosticFailure by mutableStateOf<VisitRuleFailure.Code?>(null); private set
    fun closeDiagnostic() = scope.launch(ui) {
        diagnostic = null; diagnosticError = null; diagnosticFailure = null; outsideRadius = false; callSheetOpen = false; diagnosticCallSheet = null; diagnosticOrderTerms = null
        activityForm = null; selectedIntents = emptyList(); endReview = null
        orderOpen = false; orderDraftId = null; visitOrderDrafts = emptyList(); orderReview = false; orderChecks = emptyList()
        photoCaptureOpen = false; diagnosticPhotos = emptyList()
    }
    /** AND-017: the End confirmation (what will be recorded) while the person decides; null otherwise. */
    var endReview by mutableStateOf<com.sunpride.field.storage.EndReview?>(null); private set
    /** Re-read the call and show what End will record; the same rules End enforces refuse it here first. */
    fun reviewEnd(outcome: String?, reasonCode: String?, zeroSaleReason: String? = null) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null; diagnosticFailure = null; endReview = null
        try {
            refreshDiagnostic()
            val checkin = openCheckIn(visit) ?: throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
            check(retailCall == null || retailSaved) {"Check every MSL line before ending the call"}
            // FLD-105: say so up front (the screen scrolls to the choices), not after Confirm end silently stalls.
            if (com.sunpride.field.storage.ConfiguredFieldCalls.needsNoOrderReason(diagnosticFlow, diagnosticRows, checkin.clientVisitId, zeroSaleReason))
                throw com.sunpride.callflow.CallFlowRefused(com.sunpride.callflow.CallFlowEngine.NO_ORDER_REASON)
            endReview = com.sunpride.field.storage.VisitCompletion.review(checkin.clientVisitId, outcome,
                reasonCode?.trim(), diagnosticRules, diagnosticRows, diagnosticCallSheet, now())
        } catch (e: VisitRuleFailure) { diagnosticFailure = e.code; diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: com.sunpride.callflow.CallFlowRefused) { diagnosticError = e.message }
        catch (_: Exception) { diagnosticError = "Could not check this call. Try again." }
        finally { busy = false }
    }
    fun cancelEnd() = scope.launch(ui) { endReview = null
        if (diagnosticError == com.sunpride.callflow.CallFlowEngine.NO_ORDER_REASON) diagnosticError = null }
    /** The call's final, immutable result once its End is queued. */
    fun visitResult(visit: VisitDisplay): com.sunpride.field.storage.VisitResult? = openCheckIn(visit)?.let {
        com.sunpride.field.storage.VisitCompletion.result(it.clientVisitId, diagnosticRules, diagnosticRows,
            diagnosticCallSheet)
    }
    private fun openCheckIn(visit: VisitDisplay) = relatedCall(visit).lastOrNull { (row, state) ->
        row.kind == "visit.checkIn" && state != "review"
    }?.first
    /** The visit's purposes: from its own Start once started, else the plan, else the person's choice. */
    fun visitIntents(visit: VisitDisplay): List<String> = openCheckIn(visit)?.let {
        com.sunpride.field.storage.ActivityRules.intentsOf(it.clientVisitId, diagnosticRows)
    } ?: if (visit.plannedVisitId != null) visit.intents else selectedIntents
    /** The activity checklist for the open visit, from backend rules. */
    fun activityChecklist(visit: VisitDisplay): List<com.sunpride.field.storage.ActivityRequirement> {
        val recorded = openCheckIn(visit)?.let {
            com.sunpride.field.storage.ActivityRules.recordedKinds(it.clientVisitId, diagnosticRows)
        } ?: emptySet()
        val sheet = diagnosticCallSheet
        val legacy = com.sunpride.field.storage.ActivityRules.checklist(diagnosticRules, visitIntents(visit), recorded) {
            com.sunpride.field.storage.ActivityRules.capturable(it, sheet)
        }
        return com.sunpride.field.storage.ConfiguredFieldCalls.retailActivityChecklist(diagnosticFlow, legacy, recorded) {
            com.sunpride.field.storage.ActivityRules.capturable(it, sheet)
        }
    }
    private fun serviceDay() = java.time.Instant.ofEpochMilli(now()).atZone(ZoneId.of("Asia/Manila")).toLocalDate().toString()
    private fun plans() = today.visits.mapIndexed { index, visit ->
        val json = JSONObject().put("outletId", visit.outletId)
        visit.sequence?.let { json.put("sequence", it) }
        visit.serverExecution?.let { json.put("serverExecution", JSONObject(it)) }
        SnapshotItem(visit.plannedVisitId ?: "", json.toString(), serviceDay(), visit.listPosition ?: index)
    }
    fun relatedCall(visit: VisitDisplay) = VisitCallRules.related(visit.plannedVisitId, visit.outletId, serviceDay(), diagnosticRows)
    fun startFailure(visit: VisitDisplay) = VisitCallRules.startFailure(visit.plannedVisitId, visit.outletId,
        serviceDay(), plans(), diagnosticRows)
    fun requestCallGeofence(reason: String, started: Boolean) = scope.launch(ui) {
        val visit=diagnostic ?: return@launch
        if (busy) return@launch
        busy=true
        try { withContext(io) { backend.requestGeofence(visit.outletId,reason,if (started) "geofence_end" else "geofence_start") }; diagnosticError="Sent for supervisor approval. Sync after approval, then get a fresh location." }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { diagnosticError="Connect to request approval. The call has not started or ended." }
        finally { busy=false }
    }
    var diagnosticFlow by mutableStateOf<JSONObject?>(null); private set
    private suspend fun refreshDiagnostic() {
        val visit = diagnostic
        // Rows are device-wide (not per visit), so a refresh that finishes after the screen changed
        // must still land; otherwise the next visit's Start rules read a stale, empty history.
        diagnosticRows = withContext(io) { backend.visitStates() }
        diagnosticRules = withContext(io) { backend.activityRules() }
        val sheet = visit?.outletId?.let { withContext(io) { backend.callSheet(it) } }
        val terms = visit?.outletId?.let { withContext(io) { backend.orderTerms(it) } }
        val retail = visit?.outletId?.let { withContext(io) { backend.retailCall(it) } }
        val drafts = if (visit == null) emptyList() else withContext(io) { backend.orderDrafts() }
        if (diagnostic == visit) {
            diagnosticFlow = visit?.let { v -> openCheckIn(v)?.let { com.sunpride.field.storage.ConfiguredFieldCalls.payload(it).optJSONObject("callFlowSnapshot") }
                ?: withContext(io) { backend.callFlow(v.outletId) } }
            diagnosticCallSheet = sheet
            diagnosticOrderTerms = terms
            retailCall = retail
            val calls = visit?.let { relatedCall(it) }.orEmpty().map { it.first.clientVisitId }.toSet()
            visitOrderDrafts = drafts.filter { it.clientVisitId in calls }
        }
        diagnosticPhotoTypes = withContext(io) { backend.photoTypes() }
        // The visit's latest accepted-or-pending Start owns its photos (shown after End as well).
        val call = visit?.let { openCheckIn(it) }
        val photos = call?.let { withContext(io) { backend.visitPhotos(it.clientVisitId) } } ?: emptyList()
        if (diagnostic == visit) diagnosticPhotos = photos
    }
    /** Save the open draft (or a new one) for the open call. [quantities] = productId → whole number. */
    fun saveOrderDraft(quantities: List<Pair<String, Int>>, units: Map<String, String> = emptyMap(), requestedDeliveryDate: String? = null, onSaved: () -> Unit = {}) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null
        try {
            refreshDiagnostic() // Re-read before enforcing, never trust a stale screen projection.
            val checkin = relatedCall(visit).lastOrNull { (row, state) -> row.kind == "visit.checkIn" && state != "review" }
                ?.first ?: throw OrderDraftFailure(OrderDraftFailure.Code.CALL_NOT_OPEN)
            val saved = withContext(io) {
                backend.saveOrderDraft(orderDraftId, checkin.clientVisitId, checkin.requestId, quantities, units, requestedDeliveryDate)
            }
            refreshDiagnostic()
            // Switch the editor to the saved draft only once its row is loaded (the editor re-seeds then).
            orderDraftId = saved.draftId
            onSaved()
        } catch (e: OrderDraftFailure) { diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: IllegalArgumentException) { diagnosticError = e.message ?: "Check the requested delivery day." }
        catch (_: Exception) { diagnosticError = "Could not save the order draft. Check the quantities and try again." }
        finally { busy = false }
    }
    fun discardOrderDraft() = scope.launch(ui) {
        val id = orderDraftId ?: run { orderOpen = false; return@launch }
        if (busy) return@launch
        busy = true; diagnosticError = null
        try {
            withContext(io) { backend.discardOrderDraft(id) }
            orderOpen = false; orderDraftId = null
            refreshDiagnostic()
        } catch (e: OrderDraftFailure) { diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { diagnosticError = "Could not discard the order draft." }
        finally { busy = false }
    }
    /** Do not mix separate planned visits to the same account in the editor or its dependency chain. */
    fun relatedVisitRows(visit: VisitDisplay): List<Pair<com.sunpride.field.storage.IntentRow, String>> = relatedCall(visit)
    fun queueCallSheet(drafts: List<CallSheetDraftLine>, onQueued: () -> Unit = {}) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null; diagnosticFailure = null
        try {
            refreshDiagnostic() // Re-read before enforcing, never trust a stale screen projection.
            val sheet = diagnosticCallSheet ?: error("No call sheet")
            CallSheetPayload.activity(sheet, drafts)
            // The call sheet belongs to the open call: after Start, before End.
            val checkin = relatedCall(visit).lastOrNull { (row, state) ->
                row.kind == "visit.checkIn" && state != "review"
            }?.first ?: throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
            val related = diagnosticRows.filter { it.first.clientVisitId == checkin.clientVisitId }
            if (related.any { it.first.kind == "visit.checkOut" }) throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_ENDED)
            withContext(io) { backend.queueCallSheet(checkin.clientVisitId, checkin.requestId,
                related.last().first.requestId, visit.outletId, drafts) }
            onQueued() // Main only, and only after the durable enqueue succeeded.
            refreshDiagnostic(); loadToday(sync = false)
        } catch (e: VisitRuleFailure) { diagnosticFailure = e.code; diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) {
            diagnosticError = "Could not save call sheet. Use whole numbers from 0 to 1,000,000. Sync to refresh today's access."
        } finally { busy = false }
    }
    /** Queue one AND-013 structured form for the open call (after Start, before End). */
    fun queueActivity(activity: JSONObject, onQueued: () -> Unit = {}) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null; diagnosticFailure = null
        try {
            refreshDiagnostic()
            com.sunpride.field.ui.diagnosticvisit.ActivityForms.validate(activity, diagnosticCallSheet)
            val checkin = openCheckIn(visit) ?: throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
            val related = diagnosticRows.filter { it.first.clientVisitId == checkin.clientVisitId }
            if (related.any { it.first.kind == "visit.checkOut" }) throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_ENDED)
            withContext(io) { backend.queueActivity(checkin.clientVisitId, checkin.requestId,
                related.last().first.requestId, visit.outletId, activity) }
            activityForm = null
            onQueued()
            refreshDiagnostic(); loadToday(sync = false)
        } catch (e: VisitRuleFailure) { diagnosticFailure = e.code; diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: com.sunpride.field.ui.diagnosticvisit.ActivityFormError) { diagnosticError = e.message }
        catch (_: Exception) { diagnosticError = "Could not save this activity. Check the fields, then sync to refresh today's access." }
        finally { busy = false }
    }
    /** F-310: real forms join the same call and encrypted outbox; no parallel visit state. */
    fun queueRetail(kind: String, data: JSONObject, onQueued: () -> Unit = {}) = scope.launch(ui) {
        val visit=diagnostic ?: return@launch
        if(busy) return@launch
        busy=true;diagnosticError=null;endReview=null
        try {
            refreshDiagnostic()
            val start=openCheckIn(visit) ?: throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
            val related=relatedCall(visit)
            if(related.any { it.first.kind=="visit.checkOut" }) throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_ENDED)
            val photoIds=diagnosticPhotos.filter { it.state in setOf("pending","uploaded") }.takeLast(1).map { it.localId }
            withContext(io) { backend.queueRetail(start.clientVisitId,start.requestId,related.last().first.requestId,kind,data,photoIds) }
            refreshDiagnostic();loadToday(sync=false);onQueued()
        } catch(e: kotlinx.coroutines.CancellationException) { throw e }
        catch(e: com.sunpride.callflow.CallFlowRefused) { diagnosticError=e.message }
        catch(_: Exception) { diagnosticError="Could not save the audit. Check the fields, take a photo, and complete earlier required steps." }
        finally { busy=false }
    }
    fun queueMockRefusal(outletId: String) = scope.launch(ui) {
        try { withContext(io) { backend.queueMockRefusal(outletId) }; refreshDiagnostic() }
        catch(e: kotlinx.coroutines.CancellationException) { throw e }
        catch(_: Exception) { diagnosticError="Check-in refused. The integrity report could not be saved; reconnect and refresh today's access." }
    }
    fun queueDiagnostic(kind: String, reason: String?, note: String?, outcome: String?, location: JSONObject?, flowOptions: JSONObject? = null) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null; diagnosticFailure = null
        if (kind != "visit.checkOut") endReview = null // a new activity changes what End would record
        try {
            refreshDiagnostic() // Re-read before enforcing, never trust a stale screen projection.
            val related = relatedCall(visit)
            val checkin = related.lastOrNull { it.first.kind == "visit.checkIn" && it.second != "review" }?.first
            if (kind == "visit.checkIn") VisitCallRules.requireStart(visit.plannedVisitId, visit.outletId,
                serviceDay(), plans(), diagnosticRows, if (diagnosticFlow != null) flowOptions?.optString("sequenceReason") else null)
            if (kind != "visit.checkIn" && checkin == null) throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
            if (kind == "visit.checkOut") {
                VisitCallRules.requireEnd(checkin!!.clientVisitId,
                    JSONObject().put("outcome", outcome ?: JSONObject.NULL).put("reasonCode", reason ?: JSONObject.NULL), diagnosticRows)
                com.sunpride.field.storage.ActivityRules.requireForEnd(checkin.clientVisitId, outcome, diagnosticRules,
                    diagnosticRows, diagnosticCallSheet)
            }
            // A planned visit keeps its signed MCP intents; an unplanned one needs at least one chosen purpose.
            val intents = if (visit.plannedVisitId != null) visit.intents else selectedIntents
            if (kind == "visit.checkIn" && visit.plannedVisitId == null && intents.isEmpty())
                throw VisitRuleFailure(VisitRuleFailure.Code.INTENT_REQUIRED)
            withContext(io) {
                backend.queueConfiguredVisit(kind, checkin?.clientVisitId, checkin?.requestId,
                    related.lastOrNull()?.first?.requestId, visit.plannedVisitId, visit.outletId, intents,
                    reason, note, outcome, if (outcome == "nonproductive") reason?.trim() else null, location, flowOptions)
            }
            if (kind == "visit.checkOut") endReview = null
            if (kind == "visit.checkIn" || kind == "visit.checkOut") outsideRadius = false
            // SP-0136: the day's first Start begins location sharing (if this person consented).
            if (kind == "visit.checkIn") runCatching { withContext(io) { backend.workDay?.onCheckIn(now()) } }
            refreshDiagnostic()
            loadToday(sync = false)
        } catch (e: VisitRuleFailure) { diagnosticFailure = e.code; diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: com.sunpride.callflow.CallFlowRefused) {
            diagnosticError = e.message
            // FLD-084: the approval request appears only once the phone has refused an outside-radius fix.
            if (com.sunpride.callflow.CallFlowEngine.outsideRadius(e.message)) outsideRadius = true
        }
        catch (e: Exception) { diagnosticError = com.sunpride.field.storage.QueueFailureText.of(e) }
        finally { busy = false }
    }
    /** AND-020 Team page: the summary, its direct-reports filter and an in-flight flag. */
    var team by mutableStateOf(com.sunpride.field.ui.team.TeamView()); private set
    var teamDirectOnly by mutableStateOf(true); private set
    var teamLoading by mutableStateOf(false); private set
    fun loadTeam(directOnly: Boolean = teamDirectOnly) = scope.launch(ui) {
        if (teamLoading || state !is EnrollmentState.Ready) return@launch
        if (directOnly != teamDirectOnly) team = com.sunpride.field.ui.team.TeamView()
        teamDirectOnly = directOnly; teamLoading = true
        val epoch = backend.authorizationEpoch
        try {
            val result = withContext(io) { backend.team(directOnly) }
            if (state is EnrollmentState.Ready && epoch == backend.authorizationEpoch) team = result
        }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { team = team.copy(message = "Couldn't load your team. Try again.") }
        finally { teamLoading = false }
    }
    private var signer: DeviceSigner? = null
    private var sessionGeneration = 0L

    /** On launch: restore a stored session and re-verify the device with the server. */
    fun start(configured: Boolean = true) = scope.launch(ui) {
        val generation = sessionGeneration
        try {
            runCatching { ensureKey() } // create the device key on first launch; failures surface on refresh
            if (!configured) return@launch
            val signedIn = runCatching { withContext(io) { backend.isSignedIn } }.getOrDefault(false)
            if (generation != sessionGeneration) return@launch
            if (signedIn) {
                val cached = runCatching { withContext(io) { backend.cachedDeviceId } }.getOrNull()
                if (generation != sessionGeneration) return@launch
                if (cached != null) {
                    state = EnrollmentState.Ready(cached)
                    loadToday(sync = false)
                    runCatching { withContext(io) { backend.schedulePendingWork() } }
                    today = today.copy(stale = true, warning = "Offline verification pending")
                    // SP-0140: the saved Today is on screen and usable; the server check below runs behind it.
                    launchSettled = true
                }
                refresh()
            }
        } finally { launchSettled = true }
    }

    /**
     * SP-0140: true once the launch shows a screen the person can use (saved Today, sign-in, or the
     * device status). The activity reports "fully drawn" then, so `measure-performance.sh` can time
     * cold start to a usable home, not only the first frame.
     */
    var launchSettled by mutableStateOf(false); private set

    private suspend fun ensureKey(): DeviceSigner = signer ?: withContext(io) { backend.loadSigner() }.also { s ->
        signer = s
        val info = DeviceKeyInfo(s.publicKeyBase64, fingerprint(s.publicKeySpki), s.protection.label)
        key = info
        runCatching { withContext(io) { onKeyLoaded(info) } }
    }

    /** [onSignedIn] runs on the UI context once the password sign-in succeeded (SP-0128 biometric offer). */
    fun signIn(email: String, password: String, onSignedIn: () -> Unit = {}) = scope.launch(ui) {
        val generation = ++sessionGeneration
        busy = true; error = null
        try {
            withContext(io) { backend.signIn(email, password) }
            if (generation != sessionGeneration) return@launch
            state = EnrollmentState.Unregistered // signed in; device status not yet known
            runCatching { onSignedIn() }
        } catch (e: Exception) {
            error = userMessage(e)
            busy = false
            return@launch
        }
        busy = false
        refresh()
    }

    var companySignInPending by mutableStateOf(false)
        private set
    fun updateCompanyWaiting(value: Boolean) { companySignInPending=value }
    fun companyKey(): JSONObject = backend.loadSigner().let { JSONObject().put("keyId", com.sunpride.field.device.RequestSigner.bodyDigest(it.publicKeySpki)).put("publicKeySpki",it.publicKeyBase64) }
    fun signCompanyMessage(message: String): String = backend.loadSigner().sign(message)
    fun replacementCode(): JSONObject = backend.replacementCode()
    fun creditControl(action:String,args:JSONObject):JSONObject=backend.creditControl(action,args)
    fun domainForms(kind:String,refresh:Boolean):JSONObject?=backend.domainForms(kind,refresh)
    fun sapMasters(refresh: Boolean): JSONObject? = backend.sapMasters(refresh)
    fun sapMasterLifetime(): String? = backend.sapMasterLifetime()
    fun appUpdates(): com.sunpride.integrity.AppUpdateClient? = backend.appUpdates()
    fun companySignIn(tokens: JSONObject) = scope.launch(ui) {
        ++sessionGeneration; busy=true; error=null
        try { withContext(io) { backend.companySignIn(tokens) }; state=EnrollmentState.Unregistered }
        catch(e: Exception) { error=userMessage(e); return@launch }
        finally { busy=false; companySignInPending=false }
        refresh()
    }

    /** `mine` lookup (+ bind when registered but unbound). [quiet] polls keep the current message. */
    suspend fun refresh(quiet: Boolean = false): Unit = withContext(ui) { refreshOnUi(quiet) }

    private suspend fun refreshOnUi(quiet: Boolean) {
        if (busy) return
        val generation = sessionGeneration
        busy = true
        if (!quiet) error = null
        try {
            val loaded = ensureKey()
            val enrollment = withContext(io) { backend.refreshEnrollment(loaded) }
            if (generation != sessionGeneration) return
            state = enrollment
            error = null
            if (state is EnrollmentState.Ready) loadToday(sync = true)
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) state = EnrollmentState.SignedOut
            error = userMessage(e)
        } catch (e: Exception) {
            error = userMessage(e)
        } finally {
            busy = false
            checkSuggestedOrderLifetime()
        }
    }

    private suspend fun loadToday(sync: Boolean) {
        val ready = state as? EnrollmentState.Ready ?: return
        val loaded = ensureKey()
        val generation = sessionGeneration
        try {
            val value = withContext(io) { backend.today(ready.deviceId, loaded, sync) }
            if (generation == sessionGeneration && state == ready) today = value
        } finally { checkSuggestedOrderLifetime() }
    }
    /** FLD-147: a background photo upload finished; re-read the local status and the open visit's photos. */
    fun photosChanged() = scope.launch(ui) {
        if (state is EnrollmentState.Ready && !busy) {
            runCatching { loadToday(sync = false) }
            if (diagnostic != null) runCatching { refreshDiagnostic() }
        }
    }
    fun refreshCache() = scope.launch(ui) {
        if (state is EnrollmentState.Ready && !busy) {
            runCatching { loadToday(sync = false) }.onFailure { today = today.copy(stale = true) }
        }
    }
    fun syncNow() = scope.launch(ui) {
        if (busy || state !is EnrollmentState.Ready || today.updateRequired) return@launch
        busy = true
        try { loadToday(sync = true); if (diagnostic != null) refreshDiagnostic() }
        catch (e: AuthFailure) {
            // FLD-171: a session ended elsewhere (password changed, signed out everywhere) returns to sign-in
            // with the plain reason. Queued work stays in the encrypted store for the same person.
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) { ++sessionGeneration; state = EnrollmentState.SignedOut; error = userMessage(e) }
            else today = today.copy(stale = true, warning = "Sync unavailable — showing saved visits")
        }
        catch (_: Exception) { today = today.copy(stale = true, warning = "Sync unavailable — showing saved visits") }
        finally { busy = false }
    }
    fun checkAgain(quiet: Boolean = false) = scope.launch(ui) { refresh(quiet) }
    fun queueDomain(kind:String,payload:JSONObject,aggregate:String,dependencies:List<String> = emptyList())=scope.launch(ui){
        if(busy||state !is EnrollmentState.Ready)return@launch
        busy=true;error=null
        try{withContext(io){backend.queueDomain(kind,payload,aggregate,dependencies)};loadToday(sync=false)}
        catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;error=if(e is IllegalArgumentException||e is IllegalStateException)e.message else userMessage(e)}
        finally{busy=false}
    }

    var passwordBusy by mutableStateOf(false); private set
    var passwordMessage by mutableStateOf<String?>(null); private set
    var passwordChanged by mutableStateOf(false); private set
    fun resetPasswordForm() { passwordMessage = null; passwordChanged = false }
    fun changePassword(current: String, next: String, confirm: String, onChanged: () -> Unit = {}) = scope.launch(ui) {
        if (passwordBusy || state == EnrollmentState.SignedOut) return@launch
        passwordBusy = true; passwordMessage = null; passwordChanged = false
        try {
            withContext(io) { backend.changePassword(current, next, confirm) }
            onChanged()
            passwordChanged = true
            passwordMessage = com.sunpride.field.auth.PasswordChange.SUCCESS
        } catch (e: com.sunpride.field.auth.PasswordChangeFailure) {
            passwordMessage = e.kind.text
            if (e.kind == com.sunpride.field.auth.PasswordChangeFailure.Kind.LOCAL_SESSION) signOut()
        } catch (e: AuthFailure) {
            passwordMessage = e.text
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) signOut()
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { passwordMessage = com.sunpride.field.auth.PasswordChangeFailure.Kind.SERVER.text }
        finally { passwordBusy = false }
    }

    fun signOut() = scope.launch(ui) {
        sessionGeneration++ // retire pending cache/enrollment reads before fallible teardown
        busy = true
        runCatching { withContext(io) { backend.signOut() } }
        state = EnrollmentState.SignedOut; today = TodayData(); error = null; busy = false
        team = com.sunpride.field.ui.team.TeamView(); teamDirectOnly = true
        retireSuggestedOrder()
    }

    companion object {
        /** Fixed copy only — server text, URLs and credentials never reach the screen. */
        fun userMessage(e: Throwable): String = when (e) {
            is AuthFailure -> e.text
            is ServerError -> when (e.code) {
                "device_handover_required" -> "Another phone is active for your account. Ask the office to start a controlled handover."
                "device_integrity_blocked" -> "This phone needs an integrity review before it can record work."
                "device_integrity_required" -> "Refresh this phone online before recording work. Update the app if the integrity check is unavailable."
                "Device identity mismatch" -> "This phone is registered to a different account. Ask your administrator."
                "Device scope changed", "Device scope unavailable" ->
                    "Your assignment changed. Ask your administrator to re-register this phone."
                "Device unavailable" -> "This phone isn't available for your account. Ask your administrator."
                else -> "Couldn't verify this phone. Try again."
            }
            else -> "Something went wrong. Try again."
        }
    }
}
