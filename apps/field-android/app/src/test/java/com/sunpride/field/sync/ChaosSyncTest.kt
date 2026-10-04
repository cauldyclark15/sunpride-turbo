package com.sunpride.field.sync

import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.device.RequestSigner
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.ui.diagnosticvisit.ActivityForms
import com.sunpride.field.ui.diagnosticvisit.CallSheetDraftLine
import com.sunpride.field.ui.diagnosticvisit.CallSheetPayload
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.syncstatus.SyncStatus
import com.sunpride.field.ui.syncstatus.dayClose
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.UUID
import kotlin.random.Random

/** Pure JVM chaos: no devices, sleeps, wall-clock dates, live credentials or real backend writes. */
class ChaosSyncTest {
    private val start = Instant.parse("2026-09-26T02:00:00Z").toEpochMilli()
    private val day = "2026-09-26"
    private val signer = object : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private fun fixture(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!
        .bufferedReader().use { it.readText() }

    /** Reuse the shared Room-rule fake; add only metadata/delta projections it does not implement. */
    private class Store(val persisted: FakeFieldStore, var clock: Long) : FieldStore by persisted {
        val identity = persisted.identity
        var metadata = PartitionRow(identity.account, identity.deviceId, identity.fingerprint)
        val deltas = mutableMapOf<Pair<String, String>, DeltaRow>()
        var swaps = 0
        var observe: (() -> Unit)? = null
        var afterAck: (() -> Unit)? = null
        override suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long,
            cacheExpiresAt: Long, releaseHeld: Boolean) {
            persisted.swap(generation, cursor, leaseExpiresAt, cacheExpiresAt, releaseHeld)
            val held = metadata.held && !releaseHeld
            metadata = metadata.copy(activeGeneration = generation, cursor = if (held) null else cursor,
                leaseExpiresAt = leaseExpiresAt, cacheExpiresAt = cacheExpiresAt, held = held,
                syncHealth = if (held) "held_for_review" else "synced",
                lastSuccessfulSync = if (held) metadata.lastSuccessfulSync else clock)
            swaps++; observe?.invoke()
        }
        override suspend fun enqueue(intent: IntentRow, now: Long) {
            persisted.enqueue(intent, now); observe?.invoke()
        }
        override suspend fun markSending(ids: List<String>) {
            persisted.markSending(ids); observe?.invoke()
        }
        override suspend fun resetSending() { persisted.resetSending(); observe?.invoke() }
        override suspend fun recordAck(requestId: String, entityId: String, eventIdsJson: String, serverTime: Long) {
            persisted.recordAck(requestId, entityId, eventIdsJson, serverTime)
            observe?.invoke(); afterAck?.invoke()
        }
        override suspend fun recordRejection(requestId: String, code: String) {
            persisted.recordRejection(requestId, code); observe?.invoke()
        }
        override suspend fun setCursor(cursor: String?) {
            persisted.setCursor(cursor); metadata = metadata.copy(cursor = cursor); observe?.invoke()
        }
        override suspend fun setSyncHealth(value: String) {
            persisted.setSyncHealth(value); metadata = metadata.copy(syncHealth = value); observe?.invoke()
        }
        override suspend fun markSyncSuccess(now: Long) {
            persisted.markSyncSuccess(now)
            metadata = metadata.copy(syncHealth = "synced", lastSuccessfulSync = now); observe?.invoke()
        }
        override suspend fun holdForReview() {
            persisted.holdForReview()
            metadata = metadata.copy(held = true, cursor = null, syncHealth = "held_for_review"); observe?.invoke()
        }
        var purges = 0
        /** Mirrors Room's QSR-010 purge: hold, drop the cached snapshot/lease/deltas, keep the outbox. */
        override suspend fun purgeCacheForReview() {
            persisted.purgeCacheForReview(); purges++; deltas.clear()
            metadata = metadata.copy(held = true, cursor = null, syncHealth = "held_for_review",
                activeGeneration = null, leaseExpiresAt = null, cacheExpiresAt = null); observe?.invoke()
        }
        override suspend fun delta(entity: String, id: String) = deltas[entity to id]
        override suspend fun applyDelta(changes: List<DeltaRow>, nextCursor: String) {
            check(!metadata.held && metadata.activeGeneration != null && nextCursor.isNotBlank())
            changes.forEach { c ->
                require(c.account == identity.account && c.deviceId == identity.deviceId &&
                    c.scope == identity.fingerprint && c.revision > 0)
                if ((deltas[c.entity to c.entityId]?.revision ?: 0) < c.revision) deltas[c.entity to c.entityId] = c
            }
            setCursor(nextCursor)
        }
        override suspend fun status(offline: Boolean) = SyncStatus.fromRoom(metadata,
            history().map { it.second }, offline, history().map { it.first })
    }

    private fun envelope(page: Int = 1, next: String? = null, cursor: String? = "bootstrap-cursor",
        lease: Long = dayClose(day), cache: Long = start + 6 * 60 * 60 * 1000L): String {
        val o = JSONObject(fixture("bootstrap-call-sheet-response.json"))
        val plans = o.getJSONArray("plannedVisits")
        plans.put(JSONObject(plans.getJSONObject(0).toString()).put("id", "planned-2").put("outletId", "outlet-2"))
        val outlets = o.getJSONArray("outlets")
        outlets.put(JSONObject(outlets.getJSONObject(0).toString()).put("id", "outlet-2"))
        val sheets = o.getJSONArray("callSheets")
        sheets.put(JSONObject(sheets.getJSONObject(0).toString()).put("outletId", "outlet-2"))
        o.put("page", page).put("nextPageCursor", next ?: JSONObject.NULL).put("syncCursor", cursor ?: JSONObject.NULL)
        o.getJSONObject("appConfig").put("offlineLeaseExpiresAt", lease).put("cacheExpiresAt", cache)
        return o.toString()
    }
    private suspend fun store(name: String): Store {
        val scope = StoreScope("issuer|chaos-$name", "device-$name", "scope-v1")
        val store = Store(FakeFieldStore(scope), start)
        val page = BootstrapCodec.page(envelope())
        store.swap(store.stage(BootstrapCodec.snapshot(listOf(page))), page.cursor!!, page.lease, page.cache, true)
        return store
    }
    private class Ids(private var n: Long = 0L) { fun next() = UUID(0L, ++n).toString() }
    private suspend fun enqueue(store: Store, ids: Ids, kind: String, outlet: Int = 1,
        check: IntentRow? = null, previous: IntentRow? = check, callSheet: JSONObject? = null,
        activity: JSONObject? = null, outcome: String = "completed", reason: String? = null): IntentRow {
        val row = VisitIntentFactory.create(store.identity, kind, check?.clientVisitId, check?.requestId,
            previous?.requestId, "planned-$outlet", "outlet-$outlet", emptyList(), null,
            if (kind == "visit.activity") "Offline note: quote \" and braces { } · seed-safe" else null,
            if (kind == "visit.checkOut") outcome else null, if (kind == "visit.checkOut") reason else null, null,
            at = start, uuid = ids::next, callSheet = callSheet, activity = activity)
        store.enqueue(row, store.clock)
        return row
    }
    private suspend fun offlineDay(store: Store): List<IntentRow> {
        val ids = Ids()
        for (outlet in 1..2) {
            val check = enqueue(store, ids, "visit.checkIn", outlet)
            val note = enqueue(store, ids, "visit.activity", outlet, check)
            enqueue(store, ids, "visit.checkOut", outlet, check, note)
        }
        return store.history().map { it.first }
    }

    /** Extract exact operation slices, not JSONObject-normalized bytes (including whitespace). */
    private fun operationBytes(body: ByteArray): List<ByteArray> {
        val text = body.toString(Charsets.UTF_8)
        val begin = Regex("\"operations\"\\s*:\\s*\\[").find(text)!!.range.last + 1
        val result = mutableListOf<ByteArray>()
        var depth = 0; var quoted = false; var escaped = false; var from = -1
        for (i in begin until text.length) {
            val c = text[i]
            if (quoted) {
                if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false
            } else when (c) {
                '"' -> quoted = true
                '{' -> { if (depth == 0) from = i; depth++ }
                '}' -> { depth--; if (depth == 0) result += text.substring(from, i + 1).toByteArray(Charsets.UTF_8) }
                ']' -> if (depth == 0) return result
            }
        }
        kotlin.error("Unterminated operations")
    }
    private data class Receipt(val bytes: ByteArray, val result: String)
    private inner class Server {
        val receipts = linkedMapOf<String, Receipt>()
        val appliedEvents = mutableListOf<String>()
        val deliveries = mutableMapOf<String, Int>()
        val pages = mutableMapOf<String, String>()
        var bootstrapPages = listOf(envelope())
        /** Mirrors mobile/push MCP rules: one open call, plan order, one check-in per stop, a reason for "no sale". */
        val plannedOrder = listOf("planned-1", "planned-2")
        val visitPlans = linkedMapOf<String, String?>()
        val closedVisits = mutableSetOf<String>()
        val outcomes = mutableListOf<Triple<String?, String, String?>>()
        private fun text(o: JSONObject, key: String) = o.optString(key).takeUnless { it.isBlank() || it == "null" }
        private fun applyCallRules(kind: String, payload: JSONObject, entity: String) {
            if (kind == "visit.checkIn") {
                assertTrue("call_open: a check-in arrived while a call is still open", visitPlans.keys.all { it in closedVisits })
                val planned = text(payload, "plannedVisitId")
                if (planned != null) {
                    assertFalse("A planned stop must be checked in once", planned in visitPlans.values)
                    plannedOrder.takeWhile { it != planned }.forEach { earlier ->
                        assertTrue("mcp_order: $planned before $earlier was closed",
                            visitPlans.any { (visit, plan) -> plan == earlier && visit in closedVisits })
                    }
                }
                visitPlans[entity] = planned
            } else if (kind == "visit.checkOut") {
                val outcome = payload.getString("outcome"); val reason = text(payload, "reasonCode")
                assertTrue("A nonproductive close needs a reason", outcome == "completed" || (outcome == "nonproductive" && reason != null))
                assertTrue(entity in visitPlans && closedVisits.add(entity))
                outcomes += Triple(visitPlans[entity], outcome, reason)
            } else assertFalse("Activity after the call closed", entity in closedVisits)
        }
        fun accept(raw: ByteArray): JSONObject {
            val op = JSONObject(raw.toString(Charsets.UTF_8))
            val id = op.getString("clientRequestId")
            deliveries[id] = (deliveries[id] ?: 0) + 1
            receipts[id]?.let { prior ->
                if (prior.bytes.contentEquals(raw)) return JSONObject(prior.result)
                return JSONObject().put("kind", op.getString("kind")).put("clientRequestId", id)
                    .put("status", "conflict").put("code", "conflict")
            }
            val kind = op.getString("kind")
            val payload = op.getJSONObject("payload")
            if (kind != "visit.checkIn") {
                val deps = op.getJSONArray("dependsOn")
                for (i in 0 until deps.length()) assertTrue("Server dependency must already exist", receipts.containsKey(deps.getString(i)))
                assertFalse(payload.getString("visitId").startsWith("@checkin:"))
            }
            val entity = if (kind == "visit.checkIn") "server-visit-$id" else payload.getString("visitId")
            applyCallRules(kind, payload, entity)
            val result = JSONObject().put("kind", kind).put("clientRequestId", id).put("status", "accepted")
                .put("ack", JSONObject().put("entityId", entity).put("eventIds", JSONArray().put("event-$id"))
                    .put("serverTime", start + receipts.size))
            receipts[id] = Receipt(raw.copyOf(), result.toString())
            appliedEvents += "event-$id"
            return result
        }
        fun response(path: String, bytes: ByteArray): Pair<Int, String> = 200 to when (path) {
            "/mobile/v1/push" -> JSONObject().put("type", "push.response").put("contractVersion", 1).put("serverTime", start)
                .put("results", JSONArray(operationBytes(bytes).map { accept(it) })).toString()
            "/mobile/v1/pull" -> pages[JSONObject(bytes.toString(Charsets.UTF_8)).getString("cursor")] ?: pull("steady")
            LiveBootstrapTransport.PATH -> bootstrapPages[if (JSONObject(bytes.toString(Charsets.UTF_8)).has("pageCursor")) 1 else 0]
            else -> kotlin.error("Unexpected path $path")
        }
    }
    private fun pull(cursor: String, more: Boolean = false, changes: JSONArray = JSONArray()) =
        JSONObject().put("type", "pull.response").put("contractVersion", 1).put("serverTime", start)
            .put("changes", changes).put("nextCursor", cursor).put("hasMore", more).toString()
    private fun error(code: String) = JSONObject().put("type", "error.response").put("contractVersion", 1)
        .put("serverTime", start).put("code", code).put("message", code).put("retryable", false).toString()

    private enum class Fault { PASS, BEFORE_SERVER, LOST_RESPONSE, DUPLICATE, MID_BATCH }
    private data class Attempt(val path: String, val bytes: ByteArray, val fault: Fault, val nonce: String)
    private inner class Transport(val store: Store, val server: Server, seed: Int = 0) : VisitTransport, BootstrapTransport {
        private val random = Random(seed)
        private var challenges = 0L
        val refreshes = mutableListOf<Boolean>()
        val attempts = mutableListOf<Attempt>()
        val scripts = mutableMapOf<String, ArrayDeque<Fault>>()
        var airplane = false
        var randomFaults = false
        var interruptFirstMultiBatch = false
        var partialBatches = 0
        var policy: ((String, ByteArray) -> Fault)? = null
        var reply: ((String, ByteArray) -> Pair<Int, String>?)? = null
        var beforePost: ((String, ByteArray) -> Unit)? = null
        override fun challenge(deviceId: String): Pair<String, Long> {
            assertEquals(store.identity.deviceId, deviceId)
            return UUID(1, ++challenges).toString() to start + 60_000
        }
        override fun token(refresh: Boolean): String { refreshes += refresh; return "test-only-bearer" }
        override fun post(body: ByteArray, headers: Map<String, String>, bearer: String) =
            post(LiveBootstrapTransport.PATH, body, headers, bearer)
        override fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
            assertEquals(RequestSigner.bodyDigest(bytes), headers["x-mobile-body-digest"])
            assertEquals(start.toString(), headers["x-mobile-timestamp"]) // Device-clock skew is not used for proof.
            assertEquals("POST|$path|${headers["x-mobile-body-digest"]}|${headers["x-mobile-nonce"]}|${headers["x-mobile-timestamp"]}",
                headers["x-mobile-signature"])
            assertEquals("test-only-bearer", bearer)
            if (path.endsWith("push")) runBlocking {
                operationBytes(bytes).forEach { raw ->
                    val op = JSONObject(raw.toString(Charsets.UTF_8))
                    if (op.getString("kind") != "visit.checkIn") {
                        val dep = op.getJSONArray("dependsOn").getString(0)
                        assertNotNull("Dependent sends require a durable local ack", store.ack(dep))
                        val intent = store.intent(op.getString("clientRequestId"))!!
                        val checkId = JSONObject(intent.serializedOperation).getJSONObject("payload").getString("visitId").removePrefix("@checkin:")
                        assertEquals(store.ack(checkId)!!.entityId, op.getJSONObject("payload").getString("visitId"))
                    }
                }
            }
            val scripted = scripts[path]
            val multi = path.endsWith("push") && operationBytes(bytes).size > 1
            val fault = when {
                airplane -> Fault.BEFORE_SERVER
                interruptFirstMultiBatch && multi -> { interruptFirstMultiBatch = false; Fault.MID_BATCH }
                scripted != null && scripted.isNotEmpty() -> scripted.removeFirst()
                policy != null -> policy!!.invoke(path, bytes)
                randomFaults -> when (random.nextInt(10)) {
                    0, 1 -> Fault.BEFORE_SERVER; 2, 3 -> Fault.LOST_RESPONSE
                    4 -> Fault.DUPLICATE; 5 -> Fault.MID_BATCH; else -> Fault.PASS
                }
                else -> Fault.PASS
            }
            attempts += Attempt(path, bytes.copyOf(), fault, headers["x-mobile-nonce"]!!)
            beforePost?.invoke(path, bytes)
            if (fault == Fault.BEFORE_SERVER) throw BootstrapFailure(BootstrapFailure.Kind.OFFLINE)
            reply?.invoke(path, bytes)?.let { return it }
            if (fault == Fault.MID_BATCH && multi) {
                server.accept(operationBytes(bytes).first()); partialBatches++
                throw BootstrapFailure(BootstrapFailure.Kind.OFFLINE)
            }
            val result = server.response(path, bytes)
            if (fault in setOf(Fault.LOST_RESPONSE, Fault.MID_BATCH)) throw BootstrapFailure(BootstrapFailure.Kind.OFFLINE)
            if (fault == Fault.DUPLICATE) assertEquals(result, server.response(path, bytes))
            return result
        }
    }
    private fun engine(store: Store, transport: Transport, bootstrap: suspend () -> Unit = {}) =
        VisitSync(SignedVisitGateway(transport, signer, store.identity.deviceId, { 0L }), store, store.identity,
            bootstrap, now = { store.clock }, pause = {}, jitter = { 0L })
    private fun bootstrap(store: Store, transport: Transport) {
        BootstrapClient(transport, signer, store.identity.deviceId, { fingerprint ->
            assertEquals(store.identity.fingerprint, fingerprint); store
        }, { 0L }).fetch(Instant.ofEpochMilli(store.clock).atZone(java.time.ZoneId.of("Asia/Manila"))
            .toLocalDate().toString(), store.identity.account)
    }
    private suspend fun assertFrozen(store: Store, original: List<IntentRow>) {
        assertEquals(original, store.history().map { it.first })
    }
    private suspend fun assertVisible(store: Store, offline: Boolean = false) {
        val rows = store.history()
        val status = store.status(offline)
        val unresolved = rows.count { it.second.state != "done" }
        assertEquals(unresolved, status.queued + status.sending + status.review + status.held)
        assertEquals(unresolved > 0, status.pending)
        if (unresolved > 0 || store.metadata.held) assertNotEquals("All synced", status.label(store.clock))
    }
    private suspend fun assertDrained(store: Store, server: Server, transport: Transport, original: List<IntentRow>) {
        assertFrozen(store, original)
        assertTrue(store.pending().isEmpty())
        assertTrue(store.history().all { it.second.state == "done" })
        assertEquals(original.map { it.requestId }, server.receipts.keys.toList())
        assertEquals(original.map { "event-${it.requestId}" }, server.appliedEvents)
        val firstBytes = mutableMapOf<String, ByteArray>()
        transport.attempts.filter { it.path.endsWith("push") }.forEach { attempt ->
            operationBytes(attempt.bytes).forEach { bytes ->
                val op = JSONObject(bytes.toString(Charsets.UTF_8)); val id = op.getString("clientRequestId")
                firstBytes.putIfAbsent(id, bytes)?.let { assertArrayEquals("Every operation replay must be byte-identical", it, bytes) }
            }
        }
        original.forEach { intent ->
            val receipt = server.receipts.getValue(intent.requestId)
            assertArrayEquals(firstBytes.getValue(intent.requestId), receipt.bytes)
            val ack = JSONObject(receipt.result).getJSONObject("ack")
            assertEquals(AckRow(intent.account, intent.deviceId, intent.scope, intent.requestId,
                ack.getString("entityId"), ack.getJSONArray("eventIds").toString(), ack.getLong("serverTime")), store.ack(intent.requestId))
        }
        assertEquals(transport.attempts.size, transport.attempts.map { it.nonce }.distinct().size)
        assertVisible(store)
    }

    @Test fun seededOfflineDayTwoStoresDrainsExactlyOnceInEnqueueOrder() = runBlocking {
        val exercised = mutableSetOf<Fault>()
        repeat(50) { seed ->
            val store = store("seed-$seed"); val original = offlineDay(store)
            val server = Server(); val transport = Transport(store, server, seed)
            store.observe = { runBlocking { assertVisible(store, transport.airplane) } }
            transport.airplane = true
            repeat(3) { engine(store, transport).sync(); assertFrozen(store, original) }
            assertTrue(server.receipts.isEmpty()); assertEquals(6, store.pending().size)
            transport.airplane = false; transport.randomFaults = true; transport.interruptFirstMultiBatch = true
            transport.scripts["/mobile/v1/push"] = ArrayDeque(listOf(Fault.BEFORE_SERVER, Fault.LOST_RESPONSE, Fault.DUPLICATE))
            var sync = engine(store, transport)
            repeat(24) { step ->
                if (step % 3 == 0) sync = engine(store, transport) // Fresh foreground/worker instance, same persisted store.
                assertTrue("seed=$seed step=$step", sync.sync()); assertFrozen(store, original); assertVisible(store)
            }
            transport.randomFaults = false; transport.scripts.clear()
            engine(store, transport).sync()
            assertEquals("seed=$seed", 1, transport.partialBatches.coerceAtMost(1))
            assertDrained(store, server, transport, original)
            exercised += transport.attempts.map { it.fault }
        }
        assertEquals(Fault.entries.toSet(), exercised)
    }

    /** A planned MCP day: every form at stop 1, a completed close, then stop 2 closed as "no sale". */
    private suspend fun plannedDay(store: Store): List<IntentRow> {
        val ids = Ids(); val sheet = store.callSheet("outlet-1")!!
        // The same durable guard Room runs inside its enqueue transaction (FieldStore.enqueueWithCheckpoint).
        suspend fun refusal(outlet: Int) = VisitCallRules.startFailure("planned-$outlet", "outlet-$outlet", day,
            store.todaysVisits(day), store.history().map { it.first to it.second.state })?.code
        assertEquals(VisitRuleFailure.Code.MCP_ORDER, refusal(2))
        val check = enqueue(store, ids, "visit.checkIn", 1)
        assertEquals(VisitRuleFailure.Code.CALL_OPEN, refusal(2))
        var previous = enqueue(store, ids, "visit.activity", 1, check)
        for (form in listOf(
            CallSheetPayload.activity(sheet, listOf(CallSheetDraftLine("product-1", order = "12", take = "0"))),
            ActivityForms.merchandising("compliant", "Faced the shelf"),
            ActivityForms.promotion("September hotdog bundle", "executed"),
            ActivityForms.inventoryCheck(sheet, "product-1", "present", "24"),
            ActivityForms.priceCheck(sheet, "product-1", "189.50", true),
        )) previous = if (form.getString("kind") == "call_sheet") enqueue(store, ids, "visit.activity", 1, check, previous, callSheet = form)
            else enqueue(store, ids, "visit.activity", 1, check, previous, activity = form)
        enqueue(store, ids, "visit.checkOut", 1, check, previous)
        assertEquals(VisitRuleFailure.Code.ALREADY_STARTED, refusal(1))
        assertNull(refusal(2)) // A queued, unsent End is enough to move on offline.
        val second = enqueue(store, ids, "visit.checkIn", 2)
        assertEquals(VisitRuleFailure.Code.REASON_REQUIRED, assertThrows(VisitRuleFailure::class.java) {
            runBlocking { enqueue(store, ids, "visit.checkOut", 2, second, outcome = "nonproductive") }
        }.code)
        enqueue(store, ids, "visit.checkOut", 2, second, outcome = "nonproductive", reason = "STORE_CLOSED")
        return store.history().map { it.first }
    }

    @Test fun plannedDayEveryFormAndNoSaleStopDrainsExactlyOnceUnderSeededFaults() = runBlocking {
        val exercised = mutableSetOf<Fault>()
        repeat(30) { seed ->
            val store = store("planned-$seed"); val original = plannedDay(store)
            assertEquals(10, original.size)
            val server = Server(); val transport = Transport(store, server, 1_000 + seed)
            store.observe = { runBlocking { assertVisible(store, transport.airplane) } }
            transport.airplane = true
            repeat(2) { engine(store, transport).sync(); assertFrozen(store, original) }
            assertTrue(server.receipts.isEmpty())
            transport.airplane = false; transport.randomFaults = true; transport.interruptFirstMultiBatch = true
            var sync = engine(store, transport)
            repeat(30) { step ->
                if (step % 3 == 0) sync = engine(store, transport) // Restart: fresh engine, same persisted store.
                assertTrue("seed=$seed step=$step", sync.sync()); assertFrozen(store, original); assertVisible(store)
            }
            transport.randomFaults = false
            // Reconnect: the scripted mid-batch drop may land on the first clean sync; the next one finishes.
            repeat(2) { if (store.pending().isNotEmpty()) engine(store, transport).sync() }
            assertTrue("seed=$seed", transport.partialBatches >= 1)
            assertDrained(store, server, transport, original)
            assertEquals("seed=$seed", listOf("planned-1", "planned-2"), server.visitPlans.values.toList())
            assertEquals(listOf(Triple<String?, String, String?>("planned-1", "completed", null),
                Triple("planned-2", "nonproductive", "STORE_CLOSED")), server.outcomes)
            assertEquals(listOf("note", "call_sheet", "merchandising", "promotion", "inventory_check", "price_check"),
                server.receipts.values.map { JSONObject(it.bytes.toString(Charsets.UTF_8)) }
                    .filter { it.getString("kind") == "visit.activity" }
                    .map { it.getJSONObject("payload").getJSONObject("activity").getString("kind") })
            exercised += transport.attempts.map { it.fault }
        }
        assertEquals(Fault.entries.toSet(), exercised)
    }

    private class Restart : CancellationException("test-only process boundary")
    @Test fun restartAfterEveryAckRecoversSendingRowsAndFrozenBytes() = runBlocking {
        val store = store("restart"); val original = offlineDay(store)
        val server = Server(); val transport = Transport(store, server)
        transport.scripts["/mobile/v1/push"] = ArrayDeque(listOf(Fault.LOST_RESPONSE))
        engine(store, transport).sync() // Server committed, local process never received the ack.
        assertEquals(1, server.receipts.size); assertNull(store.ack(original.first().requestId))
        store.afterAck = { throw Restart() }
        repeat(original.size) { step ->
            val next = store.pending().first().first
            // Seed the durable state a real kill after markSending would leave; cancellation's finally
            // also runs on the JVM, so it alone cannot stand in for a hard process kill.
            store.markSending(listOf(next.requestId))
            assertTrue(store.history().any { it.second.state == "sending" })
            try { engine(store, transport).sync(); fail("Expected restart after ack $step") } catch (_: Restart) { }
            assertEquals(step + 1, store.history().count { it.second.state == "done" })
            assertTrue(store.history().none { it.second.state == "sending" })
            assertFrozen(store, original)
        }
        store.afterAck = null
        engine(store, transport).sync()
        assertDrained(store, server, transport, original)
        assertTrue(server.deliveries.values.any { it > 1 })
    }

    @Test fun lostAckReconnectReturnsIdenticalAckWithoutDoubleCounting() = runBlocking {
        val store = store("lost-ack"); val original = offlineDay(store)
        val server = Server(); val transport = Transport(store, server)
        transport.scripts["/mobile/v1/push"] = ArrayDeque(listOf(Fault.LOST_RESPONSE))
        engine(store, transport).sync()
        val first = original.first().requestId
        val frozenAck = server.receipts.getValue(first).result
        assertEquals(1, server.appliedEvents.size); assertNull(store.ack(first))
        assertEquals("pending", store.history().first().second.state)
        val firstBody = transport.attempts.single { it.path.endsWith("push") }.bytes
        engine(store, transport).sync()
        assertEquals(frozenAck, server.receipts.getValue(first).result)
        assertEquals(2, server.deliveries[first])
        assertArrayEquals(firstBody, transport.attempts.filter { it.path.endsWith("push") }[1].bytes)
        assertDrained(store, server, transport, original)
    }

    @Test fun partialBatchCommitReplaysOriginalBytesAndDrainsOnce() = runBlocking {
        val store = store("mid-batch"); val original = offlineDay(store)
        val server = Server(); val transport = Transport(store, server)
        transport.interruptFirstMultiBatch = true
        engine(store, transport).sync()
        assertEquals(1, transport.partialBatches)
        assertEquals(original.take(3).map { it.requestId }, server.receipts.keys.toList())
        assertEquals(listOf("done", "done", "pending", "pending", "pending", "pending"), store.history().map { it.second.state })
        val interruptedAt = transport.attempts.indexOfFirst { it.fault == Fault.MID_BATCH }
        val interrupted = transport.attempts[interruptedAt].bytes
        assertEquals(2, operationBytes(interrupted).size)
        engine(store, transport).sync()
        val retried = transport.attempts.drop(interruptedAt + 1).first { it.path.endsWith("push") }
        assertArrayEquals(interrupted, retried.bytes)
        assertEquals(2, server.deliveries[original[2].requestId])
        assertDrained(store, server, transport, original)
    }

    @Test fun syncStatusNeverClaimsAllSyncedWithUnresolvedRows() = runBlocking {
        val store = store("status"); val original = offlineDay(store)
        val server = Server(); val transport = Transport(store, server)
        val observed = mutableSetOf<String>()
        store.observe = { runBlocking { observed += store.history().map { it.second.state }; assertVisible(store) } }
        transport.scripts["/mobile/v1/push"] = ArrayDeque(listOf(Fault.BEFORE_SERVER, Fault.LOST_RESPONSE))
        repeat(2) { engine(store, transport).sync() }
        transport.reply = { path, body -> if (!path.endsWith("push")) null else {
            val results = JSONArray(operationBytes(body).map { raw -> JSONObject(raw.toString(Charsets.UTF_8)).let { op ->
                JSONObject().put("kind", op.getString("kind")).put("clientRequestId", op.getString("clientRequestId"))
                    .put("status", "conflict").put("code", "conflict")
            } })
            200 to JSONObject().put("type", "push.response").put("contractVersion", 1).put("serverTime", start).put("results", results).toString()
        } }
        engine(store, transport).sync()
        assertEquals(setOf("pending", "sending", "review"), observed)
        assertEquals("Needs review · not synced", store.status().label(start))
        store.holdForReview()
        assertEquals(6, store.status().held); assertEquals("Held · needs review", store.status().label(start))
        assertFrozen(store, original)
        val oldScope = OutboxRow(store.identity.account, store.identity.deviceId, "previous-scope", "old", start)
        val projected = SyncStatus.fromRoom(store.metadata.copy(held = false, syncHealth = "synced"), listOf(oldScope))
        assertEquals(1, projected.held); assertNotEquals("All synced", projected.label(start))
        assertEquals("All synced", SyncStatus.fromRoom(store.metadata.copy(held = false, syncHealth = "synced"), emptyList()).label(start))
    }

    @Test fun expiredLeaseAndStaleCachePreserveQueuedWorkUntilReconnect() = runBlocking {
        for (hours in listOf(7L, 16L, 72L, 216L)) {
            val store = store("expiry-$hours"); val original = offlineDay(store)
            store.clock = start + hours * 60 * 60 * 1000
            val leaseExpired = !store.isLeaseValid(store.clock)
            assertTrue(store.status().cacheStale(store.clock))
            assertEquals(hours >= 16, leaseExpired)
            if (leaseExpired) {
                assertThrows(IllegalStateException::class.java) { runBlocking {
                    enqueue(store, Ids(1_000L), "visit.checkIn")
                } }
            }
            val server = Server(); val transport = Transport(store, server)
            transport.airplane = true
            repeat(3) { engine(store, transport).sync(); assertFrozen(store, original) }
            assertEquals(6, store.pending().size); assertTrue(server.receipts.isEmpty())
            assertFalse(store.metadata.held) // Network failure before delivery is retryable, not destructive.
            transport.airplane = false
            server.bootstrapPages = listOf(envelope(lease = store.clock + 60_000, cache = store.clock + 120_000))
            var renewals = 0
            engine(store, transport) {
                renewals++
                assertTrue(store.history().all { it.second.state == "done" }) // Delivery precedes lease renewal, even after >7 days.
                assertEquals("held_for_review", store.syncHealth())
                bootstrap(store, transport)
            }.sync()
            assertEquals(if (leaseExpired) 1 else 0, renewals)
            assertTrue(store.isLeaseValid(store.clock))
            assertDrained(store, server, transport, original)
            if (!leaseExpired) assertTrue(store.status().cacheStale(store.clock)) // Cache expiry alone does not block delivery.
        }
    }

    @Test fun revokedUnauthorizedAndCursorConflictHoldQueuedWorkOnReconnect() = runBlocking {
        for (path in listOf("/mobile/v1/pull", "/mobile/v1/push")) {
            for ((status, reason) in listOf(401 to "unauthorized", 403 to "device_revoked",
                409 to "invalid_cursor", 409 to "rebootstrap_required")) {
                val store = store("hold-$path-$reason"); val original = offlineDay(store)
                val server = Server(); val transport = Transport(store, server)
                transport.airplane = true; engine(store, transport).sync(); transport.airplane = false
                transport.reply = { p, _ -> if (p == path) status to error(reason) else null }
                var bootstraps = 0
                engine(store, transport) {
                    bootstraps++; assertEquals("held_for_review", store.syncHealth()); assertFrozen(store, original)
                    // No verified same-scope snapshot was promoted: do not release the hold.
                }.sync()
                assertEquals(if (status == 409) 1 else 0, bootstraps)
                // QSR-010: a confirmed revocation also drops the cached plan/lease; other holds keep it.
                assertEquals(if (status == 403) 1 else 0, store.purges)
                assertEquals(status == 403, store.metadata.activeGeneration == null)
                assertEquals("held_for_review", store.syncHealth()); assertNull(store.cursor())
                assertEquals(6, store.status().held); assertTrue(store.history().all { it.second.state == "pending" })
                original.forEach { assertNull(store.ack(it.requestId)) }
                assertFrozen(store, original); assertTrue(server.receipts.isEmpty())
                if (status == 401) {
                    assertEquals(2, transport.attempts.count { it.path == path && it.fault != Fault.BEFORE_SERVER })
                    assertEquals(1, transport.refreshes.count { it })
                }
                val count = transport.attempts.size
                engine(store, transport).sync()
                assertEquals(count, transport.attempts.size); assertFrozen(store, original)
            }
        }
    }

    @Test fun callSheetAndStructuredActivityLostAcksReplayWithoutMutation() = runBlocking {
        val store = store("forms"); val ids = Ids()
        val check = enqueue(store, ids, "visit.checkIn")
        val note = enqueue(store, ids, "visit.activity", check = check)
        val sheet = store.callSheet("outlet-1")!!
        val call = enqueue(store, ids, "visit.activity", check = check, previous = note,
            callSheet = CallSheetPayload.activity(sheet, listOf(CallSheetDraftLine("product-1", order = "12", take = "0"))))
        val activity = enqueue(store, ids, "visit.activity", check = check, previous = call,
            activity = ActivityForms.merchandising("needs_action", "Re-faced shelf"))
        enqueue(store, ids, "visit.checkOut", check = check, previous = activity)
        val original = store.history().map { it.first }; val server = Server(); val transport = Transport(store, server)
        val lost = mutableSetOf<String>()
        transport.policy = { path, bytes -> if (path.endsWith("push") && lost.add(JSONObject(operationBytes(bytes).first()
            .toString(Charsets.UTF_8)).getString("clientRequestId"))) Fault.LOST_RESPONSE else Fault.DUPLICATE }
        repeat(original.size + 1) { engine(store, transport).sync(); assertFrozen(store, original) }
        assertEquals(original.map { it.requestId }.toSet(), lost)
        assertEquals(listOf("note", "call_sheet", "merchandising"), server.receipts.values.map { JSONObject(it.result) }
            .filter { it.getString("kind") == "visit.activity" }.map { result ->
                JSONObject(server.receipts.getValue(result.getString("clientRequestId")).bytes.toString(Charsets.UTF_8))
                    .getJSONObject("payload").getJSONObject("activity").getString("kind")
            })
        assertDrained(store, server, transport, original)
    }

    @Test fun interruptedPullRetriesSameCursorAndKeepsDurableIntents() = runBlocking {
        val store = store("pull"); val original = offlineDay(store)
        val server = Server(); val transport = Transport(store, server)
        val upsert = JSONObject().put("seq", 1).put("entity", "visit").put("id", "remote")
            .put("revision", 1).put("op", "upsert").put("value", JSONObject().put("state", "open"))
        val tombstone = JSONObject().put("seq", 2).put("entity", "visit").put("id", "remote").put("revision", 2).put("op", "tombstone")
        server.pages["bootstrap-cursor"] = pull("middle", true, JSONArray().put(upsert))
        server.pages["middle"] = pull("final", changes = JSONArray().put(tombstone).put(upsert))
        transport.scripts["/mobile/v1/pull"] = ArrayDeque(listOf(Fault.DUPLICATE, Fault.LOST_RESPONSE, Fault.BEFORE_SERVER, Fault.DUPLICATE))
        engine(store, transport).sync()
        assertEquals("middle", store.cursor()); assertEquals(1L, store.delta("visit", "remote")!!.revision)
        assertEquals(6, store.pending().size); assertTrue(server.receipts.isEmpty())
        engine(store, transport).sync()
        assertEquals("middle", store.cursor()); assertFrozen(store, original)
        engine(store, transport).sync()
        val middle = transport.attempts.filter { it.path.endsWith("pull") &&
            JSONObject(it.bytes.toString(Charsets.UTF_8)).getString("cursor") == "middle" }
        assertEquals(3, middle.size); middle.forEach { assertArrayEquals(middle.first().bytes, it.bytes) }
        assertEquals(2L, store.delta("visit", "remote")!!.revision); assertTrue(store.delta("visit", "remote")!!.tombstone)
        assertDrained(store, server, transport, original)
    }

    @Test fun interruptedBootstrapNeverPromotesPartialSnapshotOrDropsQueue() = runBlocking {
        for (fault in listOf(Fault.BEFORE_SERVER, Fault.LOST_RESPONSE)) for (failedPage in 1..2) {
            val store = store("bootstrap-$fault-$failedPage"); val original = offlineDay(store)
            val generation = store.metadata.activeGeneration
            val server = Server(); val transport = Transport(store, server)
            server.bootstrapPages = listOf(envelope(1, "page-2", null), envelope(2, null, "renewed"))
            transport.scripts[LiveBootstrapTransport.PATH] = ArrayDeque(List(failedPage - 1) { Fault.PASS } + fault)
            assertEquals(BootstrapFailure.Kind.OFFLINE, assertThrows(BootstrapFailure::class.java) {
                bootstrap(store, transport)
            }.kind)
            assertEquals(generation, store.metadata.activeGeneration); assertEquals("bootstrap-cursor", store.cursor())
            assertEquals(1, store.swaps); assertFrozen(store, original)
            val failedBody = transport.attempts.last().bytes
            transport.scripts[LiveBootstrapTransport.PATH] = ArrayDeque(listOf(Fault.DUPLICATE, Fault.DUPLICATE))
            bootstrap(store, transport)
            assertEquals("renewed", store.cursor()); assertEquals(2, store.swaps); assertFrozen(store, original)
            assertArrayEquals(failedBody, transport.attempts.takeLast(2)[failedPage - 1].bytes)
            assertEquals(2, store.outlets().size); assertVisible(store)
            engine(store, transport).sync(); assertDrained(store, server, transport, original)
        }
    }

    @Test fun verifiedSameScopeBootstrapAfter409ResumesFrozenQueue() = runBlocking {
        val store = store("rebootstrap"); val original = offlineDay(store)
        val server = Server(); val transport = Transport(store, server)
        var denied = false; var renewed = 0
        transport.reply = { path, _ -> if (path.endsWith("pull") && !denied) {
            denied = true; 409 to error("invalid_cursor")
        } else null }
        engine(store, transport) {
            renewed++; assertEquals(6, store.status().held); assertFrozen(store, original)
            bootstrap(store, transport)
        }.sync()
        assertEquals(1, renewed); assertFalse(store.metadata.held)
        assertDrained(store, server, transport, original)
    }

    @Test fun rebootstrapAfterLongOfflineRetriesRecentWorkAndReviewsWorkBeyondSevenDays() = runBlocking {
        for (days in listOf(1L, 7L, 8L)) {
            val store = store("age-$days"); val original = offlineDay(store)
            store.clock = start + days * 24 * 60 * 60 * 1000
            val server = Server(); val transport = Transport(store, server)
            // A new day's download retains authorized outlets but omits past planned visits.
            server.bootstrapPages = listOf(JSONObject(envelope(lease = store.clock + 60_000, cache = store.clock + 120_000))
                .put("plannedVisits", JSONArray()).put("callSheets", JSONArray()).toString())
            var denied = false
            transport.reply = { path, _ -> if (path.endsWith("pull") && !denied) {
                denied = true; 409 to error("invalid_cursor")
            } else null }
            engine(store, transport) { bootstrap(store, transport) }.sync()
            assertFrozen(store, original); assertTrue(store.isLeaseValid(store.clock))
            if (days <= 7) assertDrained(store, server, transport, original) else {
                assertTrue(server.receipts.isEmpty()); assertTrue(store.history().all { it.second.state == "review" })
                assertEquals(listOf("rebootstrap_visit_changed", "dependency_missing", "dependency_missing",
                    "rebootstrap_visit_changed", "dependency_missing", "dependency_missing"),
                    store.history().map { it.second.rejectionCode })
                assertEquals(6, store.status().review); assertVisible(store)
            }
        }
    }

    @Test fun fakeServerRejectsChangedBytesForSameClientRequestId() = runBlocking {
        val store = store("server-contract"); val original = offlineDay(store); val server = Server()
        val bytes = original.first().serializedOperation.toByteArray(Charsets.UTF_8)
        val first = server.accept(bytes).toString()
        assertEquals(first, server.accept(bytes.copyOf()).toString())
        val changedPayload = JSONObject(original.first().serializedOperation).apply { getJSONObject("payload").put("deviceTime", start + 1) }
        assertEquals("conflict", server.accept(changedPayload.toString().toByteArray(Charsets.UTF_8)).getString("status"))
        val whitespaceOnly = ("{ " + original.first().serializedOperation.drop(1)).toByteArray(Charsets.UTF_8)
        assertEquals("conflict", server.accept(whitespaceOnly).getString("status"))
        assertEquals(first, server.accept(bytes).toString()); assertEquals(1, server.appliedEvents.size)
        assertArrayEquals(bytes, server.receipts.values.single().bytes)
        // The oracle applies the MCP call rules, so a phone that sent out of order would fail the suite.
        val planned = plannedDay(store("server-mcp")).filter { it.kind == "visit.checkIn" }
            .map { it.serializedOperation.toByteArray(Charsets.UTF_8) }
        val mcp = Server()
        assertThrows(AssertionError::class.java) { mcp.accept(planned[1]) } // mcp_order
        mcp.accept(planned[0])
        assertThrows(AssertionError::class.java) { mcp.accept(planned[1]) } // call_open
        assertEquals(1, mcp.receipts.size)
    }

    // A 409 whose rebootstrap loses the network leaves the partition held (cursor cleared). By
    // design only a verified bootstrap releases it: background sync must not push held work, and
    // the next foreground open bootstraps from a null cursor (LiveFieldBackend.today) and resumes.
    @Test fun failedRebootstrapStaysHeldUntilVerifiedForegroundBootstrap() = runBlocking {
        val store = store("failed-rebootstrap"); val original = offlineDay(store)
        val server = Server(); val transport = Transport(store, server)
        var conflict = true
        transport.reply = { path, _ -> if (conflict && path.endsWith("pull")) 409 to error("invalid_cursor") else null }
        transport.scripts[LiveBootstrapTransport.PATH] = ArrayDeque(listOf(Fault.BEFORE_SERVER))
        try { engine(store, transport) { bootstrap(store, transport) }.sync() } catch (_: BootstrapFailure) { }
        assertFrozen(store, original); assertTrue(store.metadata.held); assertTrue(server.receipts.isEmpty())
        conflict = false
        assertTrue(engine(store, transport).sync())
        assertFrozen(store, original); assertTrue(store.metadata.held); assertTrue(server.receipts.isEmpty())
        assertVisible(store)
        bootstrap(store, transport)
        assertFalse(store.metadata.held)
        engine(store, transport).sync()
        assertDrained(store, server, transport, original)
    }

    // Regression for a chaos-found crash: lease renewal holds the partition before bootstrapping;
    // when that bootstrap lost the network, backoff wrote retry_pending into the held partition and
    // Room threw IllegalStateException. Now the sync returns normally, durable work already pushed
    // stays done, the hold survives background retries, and a verified bootstrap renews the lease.
    @Test fun offlineLeaseRenewalStaysHeldWithoutCrashingAndVerifiedBootstrapRenews() = runBlocking {
        val store = store("failed-renewal"); val original = offlineDay(store)
        store.clock = start + 72 * 60 * 60 * 1000L
        val server = Server(); val transport = Transport(store, server)
        server.bootstrapPages = listOf(envelope(lease = store.clock + 60_000, cache = store.clock + 120_000))
        transport.scripts[LiveBootstrapTransport.PATH] = ArrayDeque(listOf(Fault.BEFORE_SERVER))
        assertTrue(engine(store, transport) { bootstrap(store, transport) }.sync())
        assertTrue(store.metadata.held); assertFalse(store.isLeaseValid(store.clock))
        assertEquals(original.map { it.requestId }, server.receipts.keys.toList())
        val sent = transport.attempts.size
        assertTrue(engine(store, transport) { bootstrap(store, transport) }.sync())
        assertEquals(sent, transport.attempts.size)
        bootstrap(store, transport)
        assertFalse(store.metadata.held); assertTrue(store.isLeaseValid(store.clock))
        assertDrained(store, server, transport, original)
    }
}
