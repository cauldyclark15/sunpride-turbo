package com.sunpride.field.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import android.content.Context
import com.sunpride.field.storage.EncryptedFieldDatabase
import kotlinx.coroutines.runBlocking
import com.sunpride.field.storage.RoomFieldStore
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.ui.diagnosticvisit.CallSheetDraftLine
import com.sunpride.field.ui.diagnosticvisit.CallSheetPayload
import com.sunpride.field.storage.SnapshotItem
import com.sunpride.field.storage.VisitCallRules
import com.sunpride.field.storage.VisitRuleFailure
import com.sunpride.field.sync.BootstrapClient
import com.sunpride.field.sync.BootstrapFailure
import com.sunpride.field.sync.LiveBootstrapTransport
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.device.RequestSigner
import org.json.JSONObject
import java.util.Base64
import java.time.LocalDate
import java.time.ZoneId
import java.security.MessageDigest
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexDeviceApi
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.auth.ConvexFunctions
import com.sunpride.field.auth.Enrollment
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.auth.SessionVault
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
    fun signOut()
    fun refreshEnrollment(signer: DeviceSigner): EnrollmentState
    fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData = TodayData()
    fun visitHistory(): List<com.sunpride.field.storage.IntentRow> = emptyList()
    fun visitStates(): List<Pair<com.sunpride.field.storage.IntentRow, String>> = emptyList()
    fun syncStatus(): com.sunpride.field.ui.syncstatus.SyncStatus = com.sunpride.field.ui.syncstatus.SyncStatus()
    fun schedulePendingWork() {}
    fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
        plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
        outcome: String?, reasonCode: String?, location: JSONObject?) { error("No local store") }
    fun callSheet(outletId: String): CallSheet? = null
    fun queueCallSheet(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, drafts: List<CallSheetDraftLine>) { error("No local store") }
    /** AND-013 activity-form rules from the active snapshot. */
    fun activityRules(): List<com.sunpride.field.storage.ActivityRule> = emptyList()
    /** Queue one structured activity form (merchandising, promotion, inventory or price check). */
    fun queueActivity(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, activity: JSONObject) { error("No local store") }
    val cachedDeviceId: String? get() = null
    /** AND-016: configured photo types (empty → provisional defaults). */
    fun photoTypes(): List<com.sunpride.field.storage.PhotoType> = emptyList()
    fun visitPhotos(clientVisitId: String): List<com.sunpride.field.storage.VisitPhoto> = emptyList()
    /** Seal the JPEG on the phone and record it for the open call; upload follows separately. */
    fun savePhoto(clientVisitId: String, checkInRequestId: String, outletId: String, photoType: String,
        jpeg: ByteArray, capturedAt: Long) { error("No local store") }
    /** Upload saved photos whose call has a server visit ID (background worker). */
    fun uploadEvidence(): com.sunpride.field.evidence.UploadReport = com.sunpride.field.evidence.UploadReport()
    /** AND-020: today's team summary (live, else saved on this phone); the server enforces scope. */
    fun team(directOnly: Boolean): com.sunpride.field.ui.team.TeamView =
        com.sunpride.field.ui.team.TeamView(message = "Team view isn't available on this phone.")
    /** ANA-010: today's suggested order for a call-sheet store (live, else saved today). Read-only. */
    fun suggestedOrder(outletId: String): com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView =
        com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(
            message = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.CONNECTION)
}

data class VisitDisplay(val outlet: String, val planned: String, val status: String,
    val outletId: String = "", val plannedVisitId: String? = null, val intents: List<String> = emptyList(),
    val sequence: Int? = null, val listPosition: Int? = null, val timeSpent: String? = null,
    /** Daily route facts from the cached snapshot; absent when an older server omitted them. */
    val outletCode: String? = null, val customerCode: String? = null, val address: String? = null,
    val latitude: Double? = null, val longitude: Double? = null)
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
    return VisitDisplay(outlet?.optString("name", "Outlet") ?: "Outlet unavailable", "Planned", "Scheduled",
        v.getString("outletId"), v.getString("id"),
        v.optJSONArray("intents")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
        VisitCallRules.sequence(row), row.listPosition,
        outletCode = text("code"), customerCode = text("customerId")?.let { customers[it] }?.takeIf { it.isNotBlank() },
        address = text("address"), latitude = latitude.takeIf { pinned }, longitude = longitude.takeIf { pinned })
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
                     val supervisor: Boolean = false)

private const val TEAM_CACHE = "local.team"
private const val SUGGESTED_ORDER_CACHE = "local.suggestedOrder"

class LiveFieldBackend(
    environment: AppEnvironment,
    private val vault: SessionVault,
    private val context: Context,
    private val signerLoader: () -> DeviceSigner
) : FieldBackend {
    private val auth = AuthClient(environment, vault)
    private val functions = ConvexFunctions(environment, auth)
    private val syncTransport = LiveBootstrapTransport(environment, auth, functions)
    private val visitTransport = com.sunpride.field.sync.LiveVisitTransport(environment, auth, functions)
    private val prefs = context.getSharedPreferences("field_cache_index", Context.MODE_PRIVATE)
    private fun storedScope(): StoreScope? {
        val key = sessionKey() ?: return null
        val account = prefs.getString("$key.subject", null) ?: return null
        val device = prefs.getString("$key.device", null) ?: return null
        val fingerprint = prefs.getString("$key.scope", null) ?: return null
        return StoreScope(account, device, fingerprint)
    }
    override fun visitStates(): List<Pair<com.sunpride.field.storage.IntentRow, String>> {
        val scope = storedScope() ?: return emptyList()
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        return try { runBlocking { store.history().map { it.first to it.second.state } } }
        finally { store.close() }
    }
    override fun visitHistory() = visitStates().map { it.first }
    override fun syncStatus(): com.sunpride.field.ui.syncstatus.SyncStatus {
        val scope = storedScope() ?: return com.sunpride.field.ui.syncstatus.SyncStatus()
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        return try { runBlocking { store.status() } } finally { store.close() }
    }
    override fun schedulePendingWork() {
        val status = syncStatus()
        if (status.queued + status.sending > 0 && status.held == 0 && status.health != "held_for_review")
            com.sunpride.field.sync.work.SyncWork.enqueue(context)
        if (status.photosWaiting > 0 && status.health != "held_for_review")
            com.sunpride.field.evidence.EvidenceWork.enqueue(context)
    }
    override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
        plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
        outcome: String?, reasonCode: String?, location: JSONObject?) {
        val scope = storedScope() ?: error("No verified local partition")
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        try {
            runBlocking {
                val intent = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, kind, clientVisitId,
                    checkInRequestId, previousRequestId, plannedVisitId, outletId, intents, unplannedReason,
                    note, outcome, reasonCode, location)
                com.sunpride.field.sync.work.QueueScheduler.enqueue(store, intent, System.currentTimeMillis()) {
                    com.sunpride.field.sync.work.SyncWork.enqueue(context)
                }
            }
        } finally { store.close() }
    }
    override fun callSheet(outletId: String): CallSheet? {
        val scope = storedScope() ?: return null
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        return try { runBlocking { store.callSheet(outletId) } } finally { store.close() }
    }
    override fun queueCallSheet(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, drafts: List<CallSheetDraftLine>) {
        val scope = storedScope() ?: error("No verified local partition")
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
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
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        return try { runBlocking { store.activityRules() } } finally { store.close() }
    }
    override fun photoTypes(): List<com.sunpride.field.storage.PhotoType> {
        val scope = storedScope() ?: return emptyList()
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        return try { runBlocking { store.photoTypes() } } finally { store.close() }
    }
    override fun visitPhotos(clientVisitId: String): List<com.sunpride.field.storage.VisitPhoto> {
        val scope = storedScope() ?: return emptyList()
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        return try { runBlocking { store.visitPhotos(clientVisitId).map { com.sunpride.field.storage.EvidencePhotos.view(it) } } }
        finally { store.close() }
    }
    override fun savePhoto(clientVisitId: String, checkInRequestId: String, outletId: String, photoType: String,
        jpeg: ByteArray, capturedAt: Long) {
        val scope = storedScope() ?: error("No verified local partition")
        require(com.sunpride.field.storage.EvidencePhotos.isJpeg(jpeg) &&
            jpeg.size.toLong() in 1..com.sunpride.field.storage.EvidencePhotos.MAX_BYTES) { "Invalid photo" }
        val files = com.sunpride.field.evidence.KeystorePhotoFiles(context)
        val localId = java.util.UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        // Sealed file first, then the row: a crash in between leaves an unreferenced file, never a row without bytes.
        files.write(localId, jpeg)
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        try {
            runBlocking {
                store.addPhoto(com.sunpride.field.storage.EvidencePhotoRow(scope.account, scope.deviceId,
                    scope.fingerprint, localId, clientVisitId, checkInRequestId, outletId, photoType,
                    com.sunpride.field.storage.EvidencePhotos.MIME, jpeg.size.toLong(),
                    com.sunpride.field.storage.EvidencePhotos.sha256Hex(jpeg), capturedAt, now), now)
            }
        } catch (e: Exception) { files.delete(localId); throw e }
        finally { store.close() }
        com.sunpride.field.diagnostics.SafeLog.event(context, "photo_saved")
        runCatching { com.sunpride.field.evidence.EvidenceWork.enqueue(context) }
    }
    override fun uploadEvidence(): com.sunpride.field.evidence.UploadReport {
        val scope = storedScope() ?: return com.sunpride.field.evidence.UploadReport()
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        return try {
            runBlocking { com.sunpride.field.evidence.EvidenceUploader(store, scope,
                com.sunpride.field.evidence.KeystorePhotoFiles(context),
                com.sunpride.field.evidence.ConvexEvidenceApi(functions)).run() }
        } finally { store.close() }
    }
    override fun queueActivity(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
        outletId: String, activity: JSONObject) {
        val scope = storedScope() ?: error("No verified local partition")
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        try { runBlocking {
            val intent = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, "visit.activity",
                clientVisitId, checkInRequestId, previousRequestId, null, outletId, emptyList(),
                null, null, null, null, null, activity = activity)
            com.sunpride.field.sync.work.QueueScheduler.enqueue(store, intent, System.currentTimeMillis()) {
                com.sunpride.field.sync.work.SyncWork.enqueue(context)
            }
        } } finally { store.close() }
    }
    private fun sessionKey(): String? = vault.readSession()?.let {
        MessageDigest.getInstance("SHA-256").digest(it.toByteArray(Charsets.UTF_8))
            .joinToString("") { b -> "%02x".format(b.toInt() and 255) }
    }
    private fun subjectFromToken(): String {
        val token = auth.convexToken()
        val claims = JSONObject(String(Base64.getUrlDecoder().decode(token.split('.')[1]), Charsets.UTF_8))
        val issuer = claims.getString("iss")
        val subject = claims.getString("sub")
        check(issuer.startsWith("https://") && subject.isNotBlank())
        return "$issuer|$subject"
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
        if (sync && !terminal) {
            com.sunpride.field.diagnostics.SafeLog.event(context, "sync_started")
            try {
                val authenticated = subjectFromToken()
                val existing = storedScope()?.takeIf { it.account == authenticated && it.deviceId == deviceId }
                val existingCursor = existing?.let { scope ->
                    val scoped = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
                    try { runBlocking { scoped.cursor() } } finally { scoped.close() }
                }
                if (existing != null && existingCursor != null) {
                    val scoped = RoomFieldStore(EncryptedFieldDatabase.open(context), existing)
                    try {
                        val gateway = com.sunpride.field.sync.SignedVisitGateway(visitTransport, signer, deviceId)
                        runBlocking {
                            com.sunpride.field.sync.VisitSync(gateway, scoped, existing, bootstrap = {
                                val page = BootstrapClient(syncTransport, signer, deviceId,
                                    { fp -> RoomFieldStore(EncryptedFieldDatabase.open(context), StoreScope(authenticated, deviceId, fp)) })
                                    .fetch(subject = authenticated)
                                if (page.fingerprint != existing.fingerprint) {
                                    // Old partition stays held; new verified scope cannot adopt its operations.
                                    prefs.edit().putString("$key.scope", page.fingerprint).apply()
                                    fingerprint = page.fingerprint
                                }
                            }).sync()
                        }
                    } finally { scoped.close() }
                } else {
                    val p = BootstrapClient(syncTransport, signer, deviceId,
                        { fp -> RoomFieldStore(EncryptedFieldDatabase.open(context), StoreScope(authenticated, deviceId, fp)) })
                        .fetch(subject = authenticated)
                    subject = authenticated; fingerprint = p.fingerprint
                    prefs.edit().putString("$key.subject", subject).putString("$key.scope", fingerprint)
                        .putString("$key.device", deviceId).apply()
                }
                val healthScope = storedScope()
                val health = healthScope?.let { scope ->
                    val scoped = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
                    try { runBlocking { scoped.syncHealth() } } finally { scoped.close() }
                }
                failed = health != "synced"
                com.sunpride.field.diagnostics.SafeLog.event(context, if (failed) "sync_retry" else "sync_complete")
                prefs.edit().putBoolean("$key.failed", failed).apply()
            } catch (e: Exception) {
                com.sunpride.field.diagnostics.SafeLog.event(context, "sync_retry")
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
                    val revoked = runCatching { ConvexDeviceApi(functions).mine(signer.publicKeyBase64)?.status }
                        .getOrNull() in setOf("revoked", "suspended")
                    if (revoked) warning = "Phone removed"
                }
                if (warning == "Update required") prefs.edit()
                    .putInt("$key.updateVersion", com.sunpride.field.BuildConfig.VERSION_CODE).apply()
                if (warning == "Phone removed") {
                    // QSR-010: confirmed revocation/suspension drops cached plan, customers and prices.
                    runBlocking { EncryptedFieldDatabase.purgeExisting(context) }
                } else if (e is BootstrapFailure && e.kind == BootstrapFailure.Kind.UNAUTHORIZED) {
                    runBlocking { EncryptedFieldDatabase.holdExisting(context) }
                }
            }
        }
        if (subject == null || fingerprint == null || prefs.getString("$key.device", null) != deviceId)
            return TodayData(warning = warning ?: if (terminal) "Update required" else null, updateRequired = terminal)
        val db = EncryptedFieldDatabase.open(context)
        try {
            val store = RoomFieldStore(db, StoreScope(subject, deviceId, fingerprint))
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
                    }, timeSpent = VisitCallRules.timeSpent(call))
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
                    com.sunpride.field.ui.team.TeamRepository.offered(store.employeeRole()))
                if (scheduleRemainder && sync && result.syncStatus.queued + result.syncStatus.sending > 0 &&
                    result.syncStatus.held == 0 && result.syncStatus.health != "held_for_review")
                    com.sunpride.field.sync.work.SyncWork.enqueue(context)
                // AND-016: a sync may have just delivered the Start ack that photos were waiting for.
                if (sync && result.syncStatus.photosWaiting > 0 && result.syncStatus.health != "held_for_review")
                    runCatching { com.sunpride.field.evidence.EvidenceWork.enqueue(context) }
                result
            }
        } finally { db.close() }
    }
    override fun team(directOnly: Boolean): com.sunpride.field.ui.team.TeamView {
        val scope = storedScope() ?: return com.sunpride.field.ui.team.TeamView(message = "Sync first to see your team.")
        val day = LocalDate.now(ZoneId.of("Asia/Manila")).toString()
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        try {
            val cache = object : com.sunpride.field.ui.team.TeamCache {
                override fun read(key: String) = runBlocking { store.localCache(TEAM_CACHE, key) }
                    ?.let { row -> row.json?.let { it to row.revision } }
                override fun write(key: String, json: String, savedAt: Long) = runBlocking {
                    store.putLocalCache(TEAM_CACHE, key, json, savedAt, "$day|")
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
        val store = RoomFieldStore(EncryptedFieldDatabase.open(context), scope)
        try {
            val cache = object : com.sunpride.field.ui.diagnosticvisit.SuggestedOrderCache {
                override fun read(key: String) = runBlocking { store.localCache(SUGGESTED_ORDER_CACHE, key) }
                    ?.let { row -> row.json?.let { it to row.revision } }
                override fun write(key: String, json: String, savedAt: Long) = runBlocking {
                    store.putLocalCache(SUGGESTED_ORDER_CACHE, key, json, savedAt, "$day|")
                }
            }
            return repo.load(outletId, day, cache, System.currentTimeMillis()) {
                val value = functions.query(com.sunpride.field.ui.diagnosticvisit.SuggestedOrderCodec.PATH,
                    com.sunpride.field.ui.diagnosticvisit.SuggestedOrderCodec.args(outletId, day))
                (value as? JSONObject)?.toString() ?: throw com.sunpride.field.ui.diagnosticvisit.SuggestedOrderWireFailure()
            }
        } finally { store.close() }
    }
    override val cachedDeviceId get() = vault.deviceId
    override val isSignedIn get() = auth.isSignedIn
    override fun loadSigner() = signerLoader()
    override fun signIn(email: String, password: String) = auth.signIn(email, password)
    override fun signOut() {
        // QSR-010: sign-out leaves only held, encrypted unsent evidence; no cached plan, customers,
        // prices or session-keyed scope index survive for the next person on this phone.
        runBlocking { EncryptedFieldDatabase.purgeExisting(context) }
        prefs.edit().clear().commit()
        auth.signOut()
    }
    override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState {
        val state = try {
            Enrollment(ConvexDeviceApi(functions), signer, vault).refresh()
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED)
                runBlocking { EncryptedFieldDatabase.holdExisting(context) }
            throw e
        }
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
    var diagnostic by mutableStateOf<VisitDisplay?>(null); private set
    var diagnosticRows by mutableStateOf<List<Pair<com.sunpride.field.storage.IntentRow, String>>>(emptyList()); private set
    var diagnosticError by mutableStateOf<String?>(null); private set
    var diagnosticCallSheet by mutableStateOf<CallSheet?>(null); private set
    var callSheetOpen by mutableStateOf(false); private set
    fun openCallSheet() = scope.launch(ui) {
        callSheetOpen = true; diagnosticError = null; endReview = null
        diagnosticCallSheet?.outletId?.let { loadSuggestedOrder(it) }
    }
    /** ANA-010 suggested order for the open call sheet; only ever fills local Order fields. */
    var suggestedOrder by mutableStateOf(com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView()); private set
    private var suggestedOrderFor: String? = null
    fun loadSuggestedOrder(outletId: String) = scope.launch(ui) {
        if (state !is EnrollmentState.Ready || (suggestedOrder.loading && suggestedOrderFor == outletId)) return@launch
        suggestedOrderFor = outletId
        suggestedOrder = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(loading = true,
            message = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.LOADING)
        val result = try { withContext(io) { backend.suggestedOrder(outletId) } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(
                message = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderRepository.CONNECTION) }
        // A different store opened meanwhile: drop this answer rather than show it on the wrong sheet.
        if (suggestedOrderFor == outletId) suggestedOrder = result
    }
    fun closeCallSheet() = scope.launch(ui) { callSheetOpen = false; diagnosticError = null }
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
        catch (_: Exception) { diagnosticError = "Could not save this photo. Try again." }
        finally { busy = false }
    }
    fun closeActivityForm() = scope.launch(ui) { activityForm = null; diagnosticError = null }
    fun toggleIntent(intent: String) = scope.launch(ui) {
        if (intent !in com.sunpride.field.storage.ActivityRules.INTENTS) return@launch
        selectedIntents = if (intent in selectedIntents) selectedIntents - intent
            else com.sunpride.field.storage.ActivityRules.INTENTS.filter { it in selectedIntents || it == intent }
    }
    fun openDiagnostic(visit: VisitDisplay) = scope.launch(ui) {
        diagnostic = visit; diagnosticError = null; diagnosticFailure = null
        callSheetOpen = false; diagnosticCallSheet = null; activityForm = null; selectedIntents = emptyList()
        endReview = null; photoCaptureOpen = false; diagnosticPhotos = emptyList()
        refreshDiagnostic()
    }
    var diagnosticFailure by mutableStateOf<VisitRuleFailure.Code?>(null); private set
    fun closeDiagnostic() = scope.launch(ui) {
        diagnostic = null; diagnosticError = null; diagnosticFailure = null; callSheetOpen = false; diagnosticCallSheet = null
        activityForm = null; selectedIntents = emptyList(); endReview = null
        photoCaptureOpen = false; diagnosticPhotos = emptyList()
    }
    /** AND-017: the End confirmation (what will be recorded) while the person decides; null otherwise. */
    var endReview by mutableStateOf<com.sunpride.field.storage.EndReview?>(null); private set
    /** Re-read the call and show what End will record; the same rules End enforces refuse it here first. */
    fun reviewEnd(outcome: String?, reasonCode: String?) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null; diagnosticFailure = null; endReview = null
        try {
            refreshDiagnostic()
            val checkin = openCheckIn(visit) ?: throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
            endReview = com.sunpride.field.storage.VisitCompletion.review(checkin.clientVisitId, outcome,
                reasonCode?.trim(), diagnosticRules, diagnosticRows, diagnosticCallSheet, now())
        } catch (e: VisitRuleFailure) { diagnosticFailure = e.code; diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { diagnosticError = "Could not check this call. Try again." }
        finally { busy = false }
    }
    fun cancelEnd() = scope.launch(ui) { endReview = null }
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
        return com.sunpride.field.storage.ActivityRules.checklist(diagnosticRules, visitIntents(visit), recorded) {
            com.sunpride.field.storage.ActivityRules.capturable(it, sheet)
        }
    }
    private fun serviceDay() = java.time.Instant.ofEpochMilli(now()).atZone(ZoneId.of("Asia/Manila")).toLocalDate().toString()
    private fun plans() = today.visits.mapIndexed { index, visit ->
        val json = JSONObject().put("outletId", visit.outletId)
        visit.sequence?.let { json.put("sequence", it) }
        SnapshotItem(visit.plannedVisitId ?: "", json.toString(), serviceDay(), visit.listPosition ?: index)
    }
    fun relatedCall(visit: VisitDisplay) = VisitCallRules.related(visit.plannedVisitId, visit.outletId, serviceDay(), diagnosticRows)
    fun startFailure(visit: VisitDisplay) = VisitCallRules.startFailure(visit.plannedVisitId, visit.outletId,
        serviceDay(), plans(), diagnosticRows)
    private suspend fun refreshDiagnostic() {
        val visit = diagnostic
        // Rows are device-wide (not per visit), so a refresh that finishes after the screen changed
        // must still land; otherwise the next visit's Start rules read a stale, empty history.
        diagnosticRows = withContext(io) { backend.visitStates() }
        diagnosticRules = withContext(io) { backend.activityRules() }
        val sheet = visit?.outletId?.let { withContext(io) { backend.callSheet(it) } }
        if (diagnostic == visit) diagnosticCallSheet = sheet
        diagnosticPhotoTypes = withContext(io) { backend.photoTypes() }
        // The visit's latest accepted-or-pending Start owns its photos (shown after End as well).
        val call = visit?.let { openCheckIn(it) }
        val photos = call?.let { withContext(io) { backend.visitPhotos(it.clientVisitId) } } ?: emptyList()
        if (diagnostic == visit) diagnosticPhotos = photos
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
            diagnosticError = "Could not save call sheet. Use whole numbers from 0 to 1,000,000 and check the offline lease."
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
        catch (_: Exception) { diagnosticError = "Could not save this activity. Check the fields and the offline lease." }
        finally { busy = false }
    }
    fun queueDiagnostic(kind: String, reason: String?, note: String?, outcome: String?, location: JSONObject?) = scope.launch(ui) {
        val visit = diagnostic ?: return@launch
        if (busy) return@launch
        busy = true; diagnosticError = null; diagnosticFailure = null
        if (kind != "visit.checkOut") endReview = null // a new activity changes what End would record
        try {
            refreshDiagnostic() // Re-read before enforcing, never trust a stale screen projection.
            val related = relatedCall(visit)
            val checkin = related.lastOrNull { it.first.kind == "visit.checkIn" && it.second != "review" }?.first
            if (kind == "visit.checkIn") VisitCallRules.requireStart(visit.plannedVisitId, visit.outletId,
                serviceDay(), plans(), diagnosticRows)
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
                backend.queueVisit(kind, checkin?.clientVisitId, checkin?.requestId,
                    related.lastOrNull()?.first?.requestId, visit.plannedVisitId, visit.outletId, intents,
                    reason, note, outcome, if (outcome == "nonproductive") reason?.trim() else null, location)
            }
            if (kind == "visit.checkOut") endReview = null
            refreshDiagnostic()
            loadToday(sync = false)
        } catch (e: VisitRuleFailure) { diagnosticFailure = e.code; diagnosticError = e.code.text }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { diagnosticError = "Could not queue visit. Sync for access and check required fields." }
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
        try { team = withContext(io) { backend.team(directOnly) } }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { team = team.copy(message = "Couldn't load your team. Try again.") }
        finally { teamLoading = false }
    }
    private var signer: DeviceSigner? = null

    /** On launch: restore a stored session and re-verify the device with the server. */
    fun start(configured: Boolean = true) = scope.launch(ui) {
        runCatching { ensureKey() } // create the device key on first launch; failures surface on refresh
        if (!configured) return@launch
        val signedIn = runCatching { withContext(io) { backend.isSignedIn } }.getOrDefault(false)
        if (signedIn) {
            val cached = runCatching { withContext(io) { backend.cachedDeviceId } }.getOrNull()
            if (cached != null) {
                state = EnrollmentState.Ready(cached)
                loadToday(sync = false)
                runCatching { withContext(io) { backend.schedulePendingWork() } }
                today = today.copy(stale = true, warning = "Offline verification pending")
            }
            refresh()
        }
    }

    private suspend fun ensureKey(): DeviceSigner = signer ?: withContext(io) { backend.loadSigner() }.also { s ->
        signer = s
        val info = DeviceKeyInfo(s.publicKeyBase64, fingerprint(s.publicKeySpki), s.protection.label)
        key = info
        runCatching { withContext(io) { onKeyLoaded(info) } }
    }

    fun signIn(email: String, password: String) = scope.launch(ui) {
        busy = true; error = null
        try {
            withContext(io) { backend.signIn(email, password) }
            state = EnrollmentState.Unregistered // signed in; device status not yet known
        } catch (e: Exception) {
            error = userMessage(e)
            busy = false
            return@launch
        }
        busy = false
        refresh()
    }

    /** `mine` lookup (+ bind when registered but unbound). [quiet] polls keep the current message. */
    suspend fun refresh(quiet: Boolean = false): Unit = withContext(ui) { refreshOnUi(quiet) }

    private suspend fun refreshOnUi(quiet: Boolean) {
        if (busy) return
        busy = true
        if (!quiet) error = null
        try {
            val loaded = ensureKey()
            state = withContext(io) { backend.refreshEnrollment(loaded) }
            error = null
            if (state is EnrollmentState.Ready) loadToday(sync = true)
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) state = EnrollmentState.SignedOut
            error = userMessage(e)
        } catch (e: Exception) {
            error = userMessage(e)
        } finally {
            busy = false
        }
    }

    private suspend fun loadToday(sync: Boolean) {
        val ready = state as? EnrollmentState.Ready ?: return
        val loaded = ensureKey()
        today = withContext(io) { backend.today(ready.deviceId, loaded, sync) }
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
        catch (_: Exception) { today = today.copy(stale = true, warning = "Sync unavailable — showing saved visits") }
        finally { busy = false }
    }
    fun checkAgain(quiet: Boolean = false) = scope.launch(ui) { refresh(quiet) }

    fun signOut() = scope.launch(ui) {
        busy = true
        runCatching { withContext(io) { backend.signOut() } }
        state = EnrollmentState.SignedOut; today = TodayData(); error = null; busy = false
        team = com.sunpride.field.ui.team.TeamView(); teamDirectOnly = true
        suggestedOrder = com.sunpride.field.ui.diagnosticvisit.SuggestedOrderView(); suggestedOrderFor = null
    }

    companion object {
        /** Fixed copy only — server text, URLs and credentials never reach the screen. */
        fun userMessage(e: Throwable): String = when (e) {
            is AuthFailure -> e.kind.message
            is ConvexFunctionError -> when (e.code) {
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
