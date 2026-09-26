package com.sunpride.field.sync

import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.device.RequestSigner
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import com.sunpride.field.storage.*
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class VisitSyncTest {
    private val identity = StoreScope("issuer|person", "device-1", "scope-v1")
    private val fixture: (String) -> String = { name ->
        javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }
    }
    private class Signer : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private class Store : FieldStore {
        val rows = mutableListOf<Pair<IntentRow, OutboxRow>>()
        val acks = mutableMapOf<String, AckRow>()
        val deltas = mutableMapOf<String, DeltaRow>()
        var token: String? = "old"; var health = "synced"; var held = false
        var visits: List<SnapshotItem> = emptyList(); var outlets: List<SnapshotItem> = emptyList()
        override suspend fun stage(snapshot: ScopedSnapshot) = "g"
        override suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long, releaseHeld: Boolean) {
            token = cursor; if (releaseHeld) { held = false; health = "synced" }
        }
        override suspend fun todaysVisits(day: String) = visits
        override suspend fun outlets() = outlets
        override suspend fun isLeaseValid(now: Long) = !held
        override suspend fun enqueue(intent: IntentRow, now: Long) {
            check(!held && rows.none { it.first.requestId == intent.requestId })
            rows += intent to OutboxRow(intent.account, intent.deviceId, intent.scope, intent.requestId, intent.createdAt)
        }
        override suspend fun pending() = rows.filter { it.second.state in setOf("pending", "sending") }
        override suspend fun history() = rows.toList()
        override suspend fun intent(requestId: String) = rows.find { it.first.requestId == requestId }?.first
        override suspend fun markSending(ids: List<String>) {
            check(ids.all { id -> rows.any { it.first.requestId == id && it.second.state == "pending" } })
            ids.forEach { id ->
                val i = rows.indexOfFirst { it.first.requestId == id }
                rows[i] = rows[i].first to rows[i].second.copy(state = "sending")
            }
        }
        override suspend fun resetSending() {
            rows.indices.forEach { i -> if (rows[i].second.state == "sending")
                rows[i] = rows[i].first to rows[i].second.copy(state = "pending") }
        }
        override suspend fun recordAck(requestId: String, entityId: String, eventIdsJson: String, serverTime: Long) {
            val i = rows.indexOfFirst { it.first.requestId == requestId }
            check(i >= 0 && rows[i].second.state in setOf("pending", "sending", "done"))
            val first = rows[i].first
            val ack = AckRow(first.account, first.deviceId, first.scope, requestId, entityId, eventIdsJson, serverTime)
            check(acks[requestId] == null || acks[requestId] == ack) { "Conflicting ack" }
            acks[requestId] = ack
            rows[i] = rows[i].first to rows[i].second.copy(state = "done")
        }
        override suspend fun recordRejection(requestId: String, code: String) {
            check(code.isNotBlank())
            val i = rows.indexOfFirst { it.first.requestId == requestId }
            check(i >= 0 && rows[i].second.state in setOf("pending", "sending"))
            rows[i] = rows[i].first to rows[i].second.copy(state = "review", rejectionCode = code)
        }
        override suspend fun ack(requestId: String) = acks[requestId]
        override suspend fun cursor() = token
        override suspend fun setCursor(cursor: String?) { token = cursor }
        override suspend fun syncHealth() = health
        override suspend fun setSyncHealth(value: String) { health = value }
        override suspend fun holdForReview() { held = true; token = null; health = "held_for_review" }
        override suspend fun delta(entity: String, id: String) = deltas["$entity:$id"]
        override suspend fun applyDelta(changes: List<DeltaRow>, nextCursor: String) {
            changes.forEach { c -> if ((deltas["${c.entity}:${c.entityId}"]?.revision ?: 0) < c.revision)
                deltas["${c.entity}:${c.entityId}"] = c }
            token = nextCursor
        }
    }
    private class Transport : VisitTransport {
        var nonce = 0
        val sent = mutableListOf<Pair<String, ByteArray>>()
        val replies = ArrayDeque<Pair<Int, String>>()
        var handler: ((String, JSONObject) -> Pair<Int, String>)? = null
        override fun challenge(deviceId: String): Pair<String, Long> = UUID.randomUUID().toString().also { nonce++ } to 1790380860000L
        override fun token(refresh: Boolean) = "test-bearer"
        override fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
            assertEquals(RequestSigner.bodyDigest(bytes), headers["x-mobile-body-digest"])
            assertEquals("POST|$path|${headers["x-mobile-body-digest"]}|${headers["x-mobile-nonce"]}|${headers["x-mobile-timestamp"]}", headers["x-mobile-signature"])
            sent += path to bytes.copyOf()
            return handler?.invoke(path, JSONObject(String(bytes))) ?: replies.removeFirst()
        }
    }
    private fun pull(next: String = "next", more: Boolean = false, changes: JSONArray = JSONArray()) =
        JSONObject().put("type", "pull.response").put("contractVersion", 1).put("serverTime", 1)
            .put("changes", changes).put("nextCursor", next).put("hasMore", more).toString()
    private fun pushResult(ops: JSONArray, status: String = "accepted", code: String = "unsupported_operation") =
        JSONObject().put("type", "push.response").put("contractVersion", 1).put("serverTime", 1)
            .put("results", JSONArray().apply { for (i in 0 until ops.length()) {
                val op = ops.getJSONObject(i)
                put(JSONObject().put("kind", op.getString("kind")).put("clientRequestId", op.getString("clientRequestId"))
                    .put("status", status).apply {
                        if (status == "accepted") put("ack", JSONObject().put("entityId", "server-visit")
                            .put("eventIds", JSONArray().put("event-1")).put("serverTime", 1))
                        else put("code", code)
                    })
            } }).toString()
    private fun engine(store: Store, transport: Transport, bootstrap: suspend () -> Unit = {}) =
        VisitSync(SignedVisitGateway(transport, Signer(), identity.deviceId, { 0L }), store, identity,
            bootstrap, pause = {}, jitter = { 0 })
    private fun enqueue(store: Store, kind: String, client: String? = null, check: String? = null, previous: String? = null): IntentRow {
        val row = VisitIntentFactory.create(identity, kind, client, check, previous, "planned-1", "outlet-1", emptyList(),
            null, if (kind == "visit.activity") "note" else null,
            if (kind == "visit.checkOut") "completed" else null, null, null, at = 1)
        runBlocking { store.enqueue(row, 1) }
        return row
    }
    @Test fun offlineEnqueueReplaySameKeyAndExactBytesAfterUncertainAcceptance() = runBlocking {
        val store = Store(); val t = Transport(); val check = enqueue(store, "visit.checkIn")
        var attempts = 0
        t.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else {
            attempts++; if (attempts == 1) 503 to "" else 200 to pushResult(body.getJSONArray("operations"))
        } }
        val sync = engine(store, t)
        sync.sync(); assertEquals("pending", store.rows.single().second.state)
        sync.sync(); assertEquals("done", store.rows.single().second.state)
        val pushed = t.sent.filter { it.first.endsWith("push") }
        assertArrayEquals(pushed[0].second, pushed[1].second)
        assertEquals(check.requestId, JSONObject(String(pushed[1].second)).getJSONArray("operations").getJSONObject(0).getString("clientRequestId"))
        assertEquals(t.sent.size, t.nonce)
    }
    @Test fun dependencyReceivesServerVisitIdAndRejectionFreezesDependents() = runBlocking {
        val store = Store(); val t = Transport(); val check = enqueue(store, "visit.checkIn")
        enqueue(store, "visit.activity", check.clientVisitId, check.requestId, check.requestId)
        enqueue(store, "visit.checkOut", check.clientVisitId, check.requestId, store.rows.last().first.requestId)
        t.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else
            200 to pushResult(body.getJSONArray("operations")) }
        engine(store, t).sync()
        assertTrue(store.rows.all { it.second.state == "done" })
        val pushed = t.sent.filter { it.first.endsWith("push") }
        assertEquals(3, pushed.size)
        val dependent = JSONObject(String(pushed[1].second)).getJSONArray("operations").getJSONObject(0)
        assertEquals("server-visit", dependent.getJSONObject("payload").getString("visitId"))
        assertEquals(check.requestId, dependent.getJSONArray("dependsOn").getString(0))
        val store2 = Store(); val t2 = Transport(); val first = enqueue(store2, "visit.checkIn")
        enqueue(store2, "visit.activity", first.clientVisitId, first.requestId, first.requestId)
        t2.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else
            200 to pushResult(body.getJSONArray("operations"), "rejected", "invalid_plan") }
        engine(store2, t2).sync()
        assertEquals(listOf("invalid_plan", "dependency_missing"), store2.rows.map { it.second.rejectionCode })
        assertEquals(1, t2.sent.count { it.first.endsWith("push") })
    }
    @Test fun unknownConflictUnsupportedNeverAccepted() = runBlocking {
        for ((status, code) in listOf("conflict" to "conflict", "rejected" to "unsupported_operation", "future" to "future")) {
            val store = Store(); val t = Transport(); enqueue(store, "visit.checkIn")
            t.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else
                200 to pushResult(body.getJSONArray("operations"), status, code) }
            engine(store, t).sync()
            assertEquals("review", store.rows.single().second.state)
            assertTrue(store.acks.isEmpty())
        }
    }
    @Test fun filteredEmptyPageAdvancesCursorAndTombstonePersists() = runBlocking {
        val store = Store(); val t = Transport()
        val tombstone = JSONArray().put(JSONObject().put("seq", 2).put("entity", "visit").put("id", "server-visit")
            .put("revision", 2).put("op", "tombstone"))
        t.replies.addAll(listOf(200 to pull("mid", true), 200 to pull("final", false, tombstone),
            200 to pull("end")))
        engine(store, t).sync()
        assertEquals("end", store.token)
        assertEquals("mid", JSONObject(String(t.sent[1].second)).getString("cursor"))
        assertTrue(store.delta("visit", "server-visit")!!.tombstone)
    }
    @Test fun rebootstrapPreservesPendingAndRevocationHolds() = runBlocking {
        val store = Store(); val t = Transport(); enqueue(store, "visit.checkIn")
        val day = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).toString()
        store.visits = listOf(SnapshotItem("planned-1", JSONObject().put("outletId", "outlet-1")
            .put("serviceDate", day).toString(), day))
        store.outlets = listOf(SnapshotItem("outlet-1", "{}"))
        t.replies.add(409 to fixture("error-invalid-cursor.json"))
        t.replies.add(200 to pushResult(JSONArray().put(JSONObject(store.rows.single().first.serializedOperation))))
        t.replies.add(200 to pull("after"))
        var bootstraps = 0
        engine(store, t) { bootstraps++; store.swap("g", "fresh", 999, 999, true) }.sync()
        assertEquals(1, bootstraps)
        assertEquals("done", store.rows.single().second.state)
        val other = Store(); val denied = Transport(); enqueue(other, "visit.checkIn")
        denied.replies.add(401 to "")
        denied.replies.add(401 to "")
        engine(other, denied).sync()
        assertTrue(other.held); assertEquals("pending", other.rows.single().second.state)
    }
    @Test fun rebootstrapChangedPlanFreezesLocalWork() = runBlocking {
        val store = Store(); val t = Transport(); val check = enqueue(store, "visit.checkIn")
        enqueue(store, "visit.activity", check.clientVisitId, check.requestId, check.requestId)
        t.replies.add(409 to fixture("error-rebootstrap-required.json"))
        t.replies.add(200 to pull("after"))
        engine(store, t) { store.swap("g", "fresh", 999, 999, true) }.sync()
        assertEquals("review", store.rows.first().second.state)
        assertEquals("review", store.rows.last().second.state)
        assertEquals(0, t.sent.count { it.first.endsWith("push") })
    }
    @Test fun batchCapAndSingleFlight() = runBlocking {
        val store = Store(); val t = Transport()
        repeat(21) { enqueue(store, "visit.checkIn") }
        t.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else
            200 to pushResult(body.getJSONArray("operations")) }
        val sync = engine(store, t)
        val one = async { sync.sync() }; val two = async { sync.sync() }; one.await(); two.await()
        assertEquals(21, store.rows.count { it.second.state == "done" })
        assertTrue(t.sent.filter { it.first.endsWith("push") }.all {
            JSONObject(String(it.second)).getJSONArray("operations").length() <= 20
        })
    }
    @Test fun overlappingSyncCallsShareOneFlight() = runBlocking {
        val store = Store(); val t = Transport(); val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        t.handler = { path, _ ->
            if (path.endsWith("pull")) { entered.countDown(); release.await(5, java.util.concurrent.TimeUnit.SECONDS); 200 to pull() }
            else error("no push")
        }
        val sync = engine(store, t)
        val first = async(kotlinx.coroutines.Dispatchers.Default) { sync.sync() }
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        val second = async(kotlinx.coroutines.Dispatchers.Default) { engine(store, t).sync() }
        assertFalse(second.await()) // separate worker-style instance shares the scope's Mutex
        release.countDown(); first.await()
        assertEquals(2, t.sent.size) // initial + final pull, not two entire sync flights
    }
    @Test fun codecFixturesAndMockWebServerBytePreservation() {
        val request = JSONObject(fixture("push-request.json"))
        assertEquals(2, request.getJSONArray("operations").length())
        val fixtureResults = JSONObject(fixture("push-response.json")).getJSONArray("results")
        assertEquals("accepted", VisitCodec.pushResults(fixture("push-response.json"), listOf(
            IntentRow("a","d","s",fixtureResults.getJSONObject(0).getString("clientRequestId"),"v","visit.checkIn","{}",0),
            IntentRow("a","d","s",fixtureResults.getJSONObject(1).getString("clientRequestId"),"v","collection.record","{}",0)
        ))[0].getString("status"))
        assertEquals("opaque-next", VisitCodec.pullPage(fixture("pull-response.json")).cursor)
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setBody(fixture("pull-response.json")))
            val bytes = VisitCodec.pull("device-1", "opaque-start")
            val result = okhttp3.OkHttpClient().newCall(okhttp3.Request.Builder().url(server.url("/mobile/v1/pull"))
                .post(bytes.toRequestBody("application/json".toMediaType())).build()).execute().use { it.body!!.string() }
            assertEquals("opaque-next", VisitCodec.pullPage(result).cursor)
            assertArrayEquals(bytes, server.takeRequest().body.readByteArray())
        }
    }
}
