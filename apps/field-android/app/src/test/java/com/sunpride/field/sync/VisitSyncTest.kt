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
        var token: String? = "old"; var health = "synced"; var held = false; var expired = false
        var visits: List<SnapshotItem> = emptyList(); var outlets: List<SnapshotItem> = emptyList()
        var workforceCurrent = true
        override suspend fun workforceSnapshotCurrent() = workforceCurrent && !held
        override suspend fun stage(snapshot: ScopedSnapshot) = "g"
        override suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long, releaseHeld: Boolean) {
            token = cursor; if (releaseHeld) { held = false; health = "synced" }
        }
        override suspend fun todaysVisits(day: String) = visits
        override suspend fun outlets() = outlets
        override suspend fun isLeaseValid(now: Long) = !held && !expired
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
        override suspend fun recordRejection(requestId: String, code: String, kept: Boolean) {
            check(code.isNotBlank())
            val i = rows.indexOfFirst { it.first.requestId == requestId }
            check(i >= 0 && rows[i].second.state in setOf("pending", "sending"))
            rows[i] = rows[i].first to rows[i].second.copy(state = if (kept) "office" else "review", rejectionCode = code)
        }
        override suspend fun ack(requestId: String) = acks[requestId]
        override suspend fun cursor() = token
        override suspend fun setCursor(cursor: String?) { token = cursor }
        override suspend fun syncHealth() = health
        override suspend fun setSyncHealth(value: String) { health = value }
        override suspend fun holdForReview() { held = true; token = null; health = "held_for_review" }
        var purged = false
        override suspend fun purgeCacheForReview() { holdForReview(); purged = true; visits = emptyList(); outlets = emptyList() }
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
    @Test fun enrollmentPhotoSizedSavesAreSplitBeforeTheRequestLimit() = runBlocking {
        val store = Store(); val transport = Transport()
        repeat(2) {
            val row = enqueue(store,"visit.checkIn")
            val op = JSONObject(row.serializedOperation).put("kind",com.sunpride.field.census.CensusRules.KIND)
            op.getJSONObject("payload").put("photoSizedFixture","x".repeat(600000))
            val i = store.rows.indexOfFirst { it.first.requestId == row.requestId }
            store.rows[i] = row.copy(kind=com.sunpride.field.census.CensusRules.KIND,serializedOperation=op.toString()) to store.rows[i].second
        }
        transport.handler = { path,body -> if(path.endsWith("push")) 200 to pushResult(body.getJSONArray("operations")) else 200 to pull() }
        engine(store,transport).sync()
        val pushes = transport.sent.filter { it.first.endsWith("push") }
        assertEquals(2,pushes.size)
        assertTrue(pushes.all { it.second.size < 1024*1024 })
        assertTrue(store.rows.all { it.second.state == "done" })
    }
    /** SP-0198: exercise the same orchestration used by LiveFieldBackend, not just VisitSync in isolation. */
    @Test fun freshDownloadAndRecoveredHoldSendSavedWorkInTheSameAttempt() = runBlocking {
        for (held in listOf(false, true)) {
            val store = Store(); val transport = Transport(); val saved = enqueue(store, "visit.checkIn")
            if (held) store.holdForReview() else store.token = null
            var downloads = 0
            transport.handler = { path, body ->
                assertFalse("only verified same-scope bootstrap releases the hold", store.held)
                if (path.endsWith("push")) 200 to pushResult(body.getJSONArray("operations")) else 200 to pull()
            }
            val response = JSONObject(fixture("bootstrap-response.json"))
                .put("page", 1).put("nextPageCursor", JSONObject.NULL).put("syncCursor", "fresh")
            response.getJSONObject("scope").put("fingerprint", identity.fingerprint)
            val bootstrapTransport = object : BootstrapTransport {
                override fun token(refresh: Boolean) = "test-only"
                override fun challenge(deviceId: String) = UUID.randomUUID().toString() to 1790380860000L
                override fun post(body: ByteArray, headers: Map<String, String>, bearer: String) = 200 to response.toString()
            }
            val session = FieldSyncSession(identity.account, identity.deviceId, { store }, {
                downloads++
                // Real decoder/stage/swap path, with only the network and encrypted-store boundary replaced.
                BootstrapClient(bootstrapTransport, Signer(), identity.deviceId, { store }, { 0L })
                    .fetch(subject = identity.account).fingerprint
            }, SignedVisitGateway(transport, Signer(), identity.deviceId, { 0L }))
            assertEquals(identity, session.sync(identity))
            assertEquals(1, downloads)
            assertEquals("done", store.history().single().second.state)
            assertEquals(saved.serializedOperation, store.history().single().first.serializedOperation)
            assertEquals(saved.requestId, store.acks.keys.single())
            assertEquals(1, transport.sent.count { it.first.endsWith("push") })
        }
    }

    @Test fun expiredWorkforceDownloadAlsoSendsInTheSameAttempt() = runBlocking {
        val store = Store(); val transport = Transport(); enqueue(store, "visit.checkIn")
        store.workforceCurrent = false
        var downloads = 0
        transport.handler = { path, body -> if (path.endsWith("push")) 200 to pushResult(body.getJSONArray("operations")) else 200 to pull() }
        FieldSyncSession(identity.account, identity.deviceId, { store }, {
            downloads++; store.workforceCurrent = true; identity.fingerprint
        }, SignedVisitGateway(transport, Signer(), identity.deviceId, { 0L })).sync(identity)
        assertEquals(1, downloads)
        assertEquals("done", store.history().single().second.state)
    }

    @Test fun reusableDownloadDoesNotDownloadAgainAndStillSends() = runBlocking {
        val store = Store(); val transport = Transport(); enqueue(store, "visit.checkIn")
        transport.handler = { path, body -> if (path.endsWith("push")) 200 to pushResult(body.getJSONArray("operations")) else 200 to pull() }
        FieldSyncSession(identity.account, identity.deviceId, { store }, { error("unnecessary download") },
            SignedVisitGateway(transport, Signer(), identity.deviceId, { 0L })).sync(identity)
        assertEquals("done", store.history().single().second.state)
    }

    @Test fun failedFreshDownloadKeepsEverySavedByteAndMakesNoSend() = runBlocking {
        val store = Store(); val transport = Transport(); val saved = enqueue(store, "visit.checkIn")
        store.holdForReview()
        val failure = BootstrapFailure(BootstrapFailure.Kind.OFFLINE)
        try {
            FieldSyncSession(identity.account, identity.deviceId, { store }, { throw failure },
                SignedVisitGateway(transport, Signer(), identity.deviceId, { 0L })).sync(identity)
            fail("download must fail")
        } catch (e: BootstrapFailure) { assertSame(failure, e) }
        assertTrue(store.held)
        assertEquals("pending", store.history().single().second.state)
        assertEquals(saved, store.history().single().first)
        assertTrue(transport.sent.isEmpty())
    }

    @Test fun changedScopeSendsOnlyItsOwnWorkAndNeverAdoptsEarlierWork() = runBlocking {
        val old = Store(); val next = Store(); val transport = Transport()
        val saved = enqueue(old, "visit.checkIn"); old.holdForReview()
        val changed = identity.copy(fingerprint = "new-scope")
        transport.handler = { path, _ ->
            assertTrue("earlier work must never be pushed", path.endsWith("pull"))
            200 to pull()
        }
        val result = FieldSyncSession(identity.account, identity.deviceId,
            { if (it == identity) old else { assertEquals(changed, it); next } }, { changed.fingerprint },
            SignedVisitGateway(transport, Signer(), identity.deviceId, { 0L })).sync(identity)
        assertEquals(changed, result)
        assertTrue(old.held)
        assertEquals(saved, old.history().single().first)
        assertEquals("pending", old.history().single().second.state)
        assertTrue(old.acks.isEmpty())
    }

    @Test fun alreadyQueuedWorkPushesAfterDayCloseThenRenewsAccessWithoutDropping() = runBlocking {
        val store = Store(); val transport = Transport(); val queued = enqueue(store, "visit.checkIn")
        store.expired = true
        var bootstraps = 0
        transport.handler = { path, body -> if (path.endsWith("push")) 200 to pushResult(body.getJSONArray("operations")) else 200 to pull() }
        engine(store, transport) {
            assertEquals("done", store.history().single().second.state) // Delivery precedes access renewal.
            bootstraps++; store.expired = false; store.swap("g", "fresh", 999, 999, true)
        }.sync()
        assertEquals(1, bootstraps)
        assertEquals("done", store.history().single().second.state)
        assertEquals(queued.serializedOperation, store.history().single().first.serializedOperation)
        assertEquals(1, transport.sent.count { it.first.endsWith("push") })
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
    /** SP-0189: `kept: true` = the office has a copy. The row ends `office`: never waiting, never listed, and its
     * dependents are still stopped exactly as for any refused Start. Without `kept` (older server) it stays `review`. */
    @Test fun keptRefusalEndsOfficeAndStillStopsDependents() = runBlocking {
        for (kept in listOf(true, false)) {
            val store = Store(); val t = Transport(); val first = enqueue(store, "visit.checkIn")
            enqueue(store, "visit.activity", first.clientVisitId, first.requestId, first.requestId)
            t.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else
                200 to JSONObject(pushResult(body.getJSONArray("operations"), "rejected", "invalid_request")).also { r ->
                    if (kept) r.getJSONArray("results").getJSONObject(0).put("kept", true) }.toString() }
            engine(store, t).sync()
            assertEquals(listOf(if (kept) "office" else "review", "review"), store.rows.map { it.second.state })
            assertEquals(listOf("invalid_request", "dependency_missing"), store.rows.map { it.second.rejectionCode })
            assertEquals(first.requestId, store.rows.first().first.requestId)
            assertEquals(1, t.sent.count { it.first.endsWith("push") })
            val status = com.sunpride.field.ui.syncstatus.SyncStatus.fromRoom(
                com.sunpride.field.storage.PartitionRow(identity.account, identity.deviceId, identity.fingerprint, lastSuccessfulSync = 1),
                store.rows.map { it.second })
            assertEquals("All sent", status.label(2))
        }
    }
    @Test fun fieldDayReasonIsMoreSpecificThanFrozenCode() = runBlocking {
        for (reason in listOf("call_open", "mcp_order", "wrong_date")) {
            val store = Store(); val t = Transport(); enqueue(store, "visit.checkIn")
            t.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else
                200 to JSONObject(pushResult(body.getJSONArray("operations"), "rejected", "invalid_request")).also { r ->
                    r.getJSONArray("results").getJSONObject(0).put("reason", reason) }.toString() }
            engine(store, t).sync()
            assertEquals(reason, store.rows.single().second.rejectionCode)
        }
        // An unknown reason falls back to the frozen v1 code.
        val store = Store(); val t = Transport(); enqueue(store, "visit.checkIn")
        t.handler = { path, body -> if (path.endsWith("pull")) 200 to pull() else
            200 to JSONObject(pushResult(body.getJSONArray("operations"), "rejected", "invalid_request")).also { r ->
                r.getJSONArray("results").getJSONObject(0).put("reason", "future_rule") }.toString() }
        engine(store, t).sync()
        assertEquals("invalid_request", store.rows.single().second.rejectionCode)
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
        // Factory dates are derived from deviceTime now; this recovery case is today's work.
        val row = store.rows.single()
        store.rows[0] = row.first.copy(serializedOperation = JSONObject(row.first.serializedOperation).apply {
            getJSONObject("payload").put("deviceTime", System.currentTimeMillis()).put("serviceDate", day)
        }.toString()) to row.second
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
    /** QSR-010: a confirmed revocation drops the cached plan; an unexplained 401 only holds. */
    @Test fun revokedDevicePurgesCacheButUnauthorizedOnlyHolds() = runBlocking {
        val revoked = Store(); val t = Transport(); enqueue(revoked, "visit.checkIn")
        revoked.outlets = listOf(SnapshotItem("outlet-1", "{}"))
        t.replies.add(403 to fixture("error-device-revoked.json"))
        engine(revoked, t).sync()
        assertTrue(revoked.held); assertTrue(revoked.purged); assertTrue(revoked.outlets.isEmpty())
        assertEquals("pending", revoked.rows.single().second.state) // unsent work kept for review
        val denied = Store(); val d = Transport(); enqueue(denied, "visit.checkIn")
        denied.outlets = listOf(SnapshotItem("outlet-1", "{}"))
        d.replies.add(401 to ""); d.replies.add(401 to "")
        engine(denied, d).sync()
        assertTrue(denied.held); assertFalse(denied.purged); assertEquals(1, denied.outlets.size)
    }
    @Test fun rebootstrapKeepsValidPastDayEvenWhenNewBootstrapOmitsItsPlan() = runBlocking {
        val store = Store(); val transport = Transport()
        val at = java.time.Instant.parse("2026-10-02T02:00:00Z").toEpochMilli()
        val now = java.time.Instant.parse("2026-10-04T02:00:00Z").toEpochMilli()
        val intent = VisitIntentFactory.create(identity, "visit.checkIn", null, null, null,
            "past-plan", "outlet-1", emptyList(), null, null, null, null, null, at)
        store.enqueue(intent, at)
        store.outlets = listOf(SnapshotItem("outlet-1", "{}"))
        transport.replies.add(409 to fixture("error-invalid-cursor.json"))
        transport.replies.add(200 to pushResult(JSONArray().put(JSONObject(intent.serializedOperation))))
        transport.replies.add(200 to pull("after"))
        VisitSync(SignedVisitGateway(transport, Signer(), identity.deviceId, { 0L }), store, identity,
            bootstrap = { store.swap("g", "fresh", 999, 999, true) }, now = { now }, pause = {}, jitter = { 0 }).sync()
        assertEquals("done", store.history().single().second.state)
        assertEquals(intent.serializedOperation, store.history().single().first.serializedOperation)
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
