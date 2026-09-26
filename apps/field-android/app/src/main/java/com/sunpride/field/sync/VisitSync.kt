package com.sunpride.field.sync

import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.ConvexFunctions
import com.sunpride.field.auth.ConvexDeviceApi
import com.sunpride.field.auth.JSON_MEDIA
import com.sunpride.field.auth.defaultHttpClient
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.RequestSigner
import com.sunpride.field.storage.DeltaRow
import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import kotlin.math.min
import kotlin.random.Random

interface VisitTransport {
    fun challenge(deviceId: String): Pair<String, Long>
    fun token(refresh: Boolean): String
    fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String>
}

class LiveVisitTransport(environment: AppEnvironment, private val auth: AuthClient,
    functions: ConvexFunctions, private val http: OkHttpClient = defaultHttpClient()) : VisitTransport {
    private val devices = ConvexDeviceApi(functions)
    private val site = environment.siteUrl.trimEnd('/')
    override fun challenge(deviceId: String) = devices.challenge(deviceId)
    override fun token(refresh: Boolean) = auth.convexToken(forceRefresh = refresh)
    override fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
        val request = Request.Builder().url(site + path).header("Authorization", "Bearer $bearer").apply {
            headers.forEach { (key, value) -> header(key, value) }
        }.post(bytes.toRequestBody(JSON_MEDIA)).build()
        return try { http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() } }
        catch (_: IOException) { throw BootstrapFailure(BootstrapFailure.Kind.OFFLINE) }
    }
}

/** Only a transport-owned 401 gets one new JWT, nonce and signature; uncertain outcomes retain original bytes. */
class SignedVisitGateway(private val transport: VisitTransport, private val signer: DeviceSigner,
    private val deviceId: String, private val monotonic: () -> Long = { System.nanoTime() / 1_000_000 }) {
    fun post(path: String, bytes: ByteArray): Pair<Int, String> {
        for (attempt in 0..1) {
            val bearer = transport.token(attempt != 0)
            val start = monotonic()
            val (nonce, expiry) = transport.challenge(deviceId)
            val stamp = expiry - 60_000 + (monotonic() - start)
            val headers = RequestSigner.headers(signer, deviceId, path, bytes, nonce, stamp)
            val result = transport.post(path, bytes, headers, bearer)
            if (result.first != 401) return result
        }
        return 401 to ""
    }
}

object VisitCodec {
    fun push(deviceId: String, operations: List<String>): ByteArray {
        require(operations.size in 1..20)
        val a = JSONArray(); operations.forEach { a.put(JSONObject(it)) }
        return JSONObject().put("type", "push.request").put("contractVersion", 1)
            .put("deviceId", deviceId).put("operations", a).toString().toByteArray(Charsets.UTF_8)
    }
    fun pull(deviceId: String, cursor: String): ByteArray = JSONObject().put("type", "pull.request")
        .put("contractVersion", 1).put("deviceId", deviceId).put("cursor", cursor)
        .put("limit", 50).toString().toByteArray(Charsets.UTF_8)
    fun pushResults(text: String, sent: List<IntentRow>): List<JSONObject> {
        val o = JSONObject(text)
        check(o.getString("type") == "push.response" && o.getInt("contractVersion") == 1 && o.has("serverTime"))
        val a = o.getJSONArray("results")
        check(a.length() == sent.size)
        return sent.indices.map { i -> a.getJSONObject(i).also {
            check(it.getString("clientRequestId") == sent[i].requestId && it.getString("kind") == sent[i].kind)
        } }
    }
    data class Page(val changes: List<JSONObject>, val cursor: String, val more: Boolean)
    fun pullPage(text: String): Page {
        val o = JSONObject(text)
        check(o.getString("type") == "pull.response" && o.getInt("contractVersion") == 1 && o.has("serverTime"))
        val cursor = o.getString("nextCursor"); check(cursor.isNotBlank())
        val a = o.getJSONArray("changes")
        return Page((0 until a.length()).map { a.getJSONObject(it) }, cursor, o.getBoolean("hasMore"))
    }
    fun error(text: String): String? = runCatching { BootstrapCodec.error(text).code }.getOrNull()
}

/** Foreground single-flight for one authenticated partition. Never holds a mutex across UI state writes. */
class VisitSync(private val gateway: SignedVisitGateway, private val store: FieldStore,
    private val scope: StoreScope, private val bootstrap: suspend () -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
    private val pause: suspend (Long) -> Unit = { kotlinx.coroutines.delay(it) },
    private val jitter: () -> Long = { Random.nextLong(250) }) {
    companion object {
        private val flights = java.util.concurrent.ConcurrentHashMap<StoreScope, Mutex>()
        private val attempts = java.util.concurrent.ConcurrentHashMap<StoreScope, java.util.concurrent.atomic.AtomicInteger>()
    }
    private val flight = flights.computeIfAbsent(scope) { Mutex() }
    private val retry = attempts.computeIfAbsent(scope) { java.util.concurrent.atomic.AtomicInteger() }
    suspend fun sync(): Boolean = withContext(Dispatchers.IO) {
        if (!flight.tryLock()) return@withContext false
        try {
            store.resetSending() // Recover an interrupted send; replay retains the immutable request ID.
            if (store.syncHealth() == "held_for_review") return@withContext true
            try {
                pull()
                if (store.isLeaseValid(now())) push() else if (store.pending().isNotEmpty())
                    throw BootstrapFailure(BootstrapFailure.Kind.RESTART)
                pull()
                retry.set(0)
                store.markSyncSuccess(now())
            } catch (e: BootstrapFailure) {
                when (e.kind) {
                    BootstrapFailure.Kind.REMOVED, BootstrapFailure.Kind.UNAUTHORIZED,
                    BootstrapFailure.Kind.UPDATE_REQUIRED -> store.holdForReview()
                    BootstrapFailure.Kind.RESTART -> {
                        store.holdForReview()
                        // Bootstrap's verified same-partition swap alone releases this hold.
                        bootstrap()
                        if (store.syncHealth() != "held_for_review") {
                            freezeInvalidAfterBootstrap()
                            if (store.isLeaseValid(now())) push()
                            pull()
                            store.markSyncSuccess(now())
                        }
                    }
                    else -> backoff()
                }
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { backoff() }
            true
        } finally {
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { store.resetSending() }
            flight.unlock()
        }
    }
    private suspend fun freezeInvalidAfterBootstrap() {
        val day = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).toString()
        val planned = store.todaysVisits(day).associateBy { it.id }
        val outlets = store.outlets().map { it.id }.toSet()
        for ((intent, _) in store.pending()) {
            if (intent.kind != "visit.checkIn") continue
            val payload = JSONObject(intent.serializedOperation).getJSONObject("payload")
            val plan = payload.optString("plannedVisitId").takeIf { it.isNotBlank() && it != "null" }
            val valid = payload.optString("serviceDate") == day && payload.optString("outletId") in outlets &&
                (plan == null || planned[plan]?.let {
                    val row = JSONObject(it.json)
                    row.optString("outletId") == payload.optString("outletId") && row.optString("serviceDate") == day
                } == true)
            if (!valid) store.recordRejection(intent.requestId, "rebootstrap_visit_changed")
        }
    }
    private suspend fun backoff() {
        val step = retry.updateAndGet { min(it + 1, 6) }
        store.setSyncHealth("retry_pending")
        pause(min(30_000L, 500L shl step) + jitter())
    }
    private fun failure(code: Int, body: String): BootstrapFailure {
        val reason = VisitCodec.error(body)
        return BootstrapFailure(when {
            code == 401 -> BootstrapFailure.Kind.UNAUTHORIZED
            code == 409 || reason in setOf("rebootstrap_required", "invalid_cursor") -> BootstrapFailure.Kind.RESTART
            reason == "device_revoked" || reason == "scope_changed" -> BootstrapFailure.Kind.REMOVED
            reason == "version_unsupported" -> BootstrapFailure.Kind.UPDATE_REQUIRED
            else -> BootstrapFailure.Kind.RETRYABLE
        })
    }
    private suspend fun pull() {
        val seen = mutableSetOf<String>()
        repeat(100) {
            val cursor = store.cursor() ?: return
            check(seen.add(cursor))
            val (code, text) = gateway.post("/mobile/v1/pull", VisitCodec.pull(scope.deviceId, cursor))
            if (code !in 200..299) throw failure(code, text)
            val page = VisitCodec.pullPage(text)
            val changes = page.changes.map { c ->
                val entity = c.getString("entity"); val op = c.getString("op")
                check(entity in setOf("visit", "activity") && op in setOf("upsert", "tombstone"))
                val value = if (op == "upsert") c.getJSONObject("value").toString() else null
                DeltaRow(scope.account, scope.deviceId, scope.fingerprint, entity, c.getString("id"),
                    c.getLong("revision"), value, op == "tombstone")
            }
            // Including an empty filtered page: cursor + changes must commit together.
            store.applyDelta(changes, page.cursor)
            if (!page.more) return
        }
        throw BootstrapFailure(BootstrapFailure.Kind.RESTART)
    }
    private suspend fun push() {
        while (true) {
            val pending = store.pending().take(20)
            if (pending.isEmpty()) return
            val ready = mutableListOf<IntentRow>(); val wire = mutableListOf<String>()
            for ((intent, _) in pending) {
                val op = JSONObject(intent.serializedOperation)
                if (intent.kind != "visit.checkIn") {
                    val deps = op.getJSONArray("dependsOn")
                    val dependency = deps.getString(0)
                    val ack = store.ack(dependency)
                    val checkInId = op.getJSONObject("payload").getString("visitId").removePrefix("@checkin:")
                    val visitAck = store.ack(checkInId)
                    if (ack == null || visitAck == null) {
                        val dep = store.history().find { it.first.requestId == dependency }
                        if (dep?.second?.state == "review" || dep == null)
                            store.recordRejection(intent.requestId, "dependency_missing")
                        if (ready.isNotEmpty()) break
                        continue
                    }
                    // Local immutable template uses a check-in request reference, NOT a fabricated server ID.
                    // The server visit ID is inserted only into the outgoing operation after its ack is durable.
                    if (op.getJSONObject("payload").getString("visitId").startsWith("@checkin:"))
                        op.getJSONObject("payload").put("visitId", visitAck.entityId)
                }
                ready.add(intent); wire.add(op.toString())
            }
            if (ready.isEmpty()) return
            store.markSending(ready.map { it.requestId })
            val (code, text) = gateway.post("/mobile/v1/push", VisitCodec.push(scope.deviceId, wire))
            if (code !in 200..299) throw failure(code, text)
            val results = VisitCodec.pushResults(text, ready)
            for ((index, result) in results.withIndex()) {
                val requestId = ready[index].requestId
                when (responseStatus(result.getString("status")).raw) {
                    "accepted" -> {
                        val ack = result.getJSONObject("ack")
                        val events = ack.getJSONArray("eventIds")
                        store.recordAck(requestId, ack.getString("entityId"), events.toString(), ack.getLong("serverTime"))
                    }
                    else -> store.recordRejection(requestId,
                        result.optString("code").takeIf { it.isNotBlank() } ?: "unknown_status")
                }
            }
        }
    }
}
