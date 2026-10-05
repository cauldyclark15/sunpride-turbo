package com.sunpride.field.ui

import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.device.RequestSigner
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.*
import com.sunpride.field.ui.diagnosticvisit.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

class CallSheetControllerTest {
    private val scope = StoreScope("issuer|person", "device", "scope")
    private val visit = VisitDisplay("Account", "Planned", "Scheduled", "outlet-1", "planned-1")
    private val signer = object : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private fun snapshot(): ScopedSnapshot {
        val text = javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!
            .bufferedReader().use { it.readText() }
        return BootstrapCodec.snapshot(listOf(BootstrapCodec.page(text)))
    }
    private inner class Backend(val store: FakeFieldStore) : FieldBackend {
        override val isSignedIn = true
        override val cachedDeviceId = scope.deviceId
        override fun loadSigner() = signer
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(scope.deviceId)
        override fun visitStates() = runBlocking { store.history().map { it.first to it.second.state } }
        override fun callSheet(outletId: String) = runBlocking { store.callSheet(outletId) }
        val suggestionCalls = mutableListOf<String>()
        override fun suggestedOrder(outletId: String): SuggestedOrderView {
            suggestionCalls += outletId
            return SuggestedOrderView(SuggestedOrder("v1", "2026-09-29", outletId, 8, 7, 1, true, listOf(
                SuggestedLine("product-1", "SUNP-001", "Hotdog", "PC", "suggest", 8.0, listOf("Suggest 8 PC")),
                SuggestedLine("product-2", "HOL-010", "Corned beef", "CAN", "enough_stock", 0.0, emptyList()))))
        }
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: JSONObject?) = runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, kind, clientVisitId, checkInRequestId, previousRequestId,
                plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode, location, at = 100), 100)
        }
        override fun queueCallSheet(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
            outletId: String, drafts: List<CallSheetDraftLine>) = runBlocking {
            val sheet = store.callSheet(outletId) ?: error("No call sheet")
            store.enqueue(VisitIntentFactory.create(scope, "visit.activity", clientVisitId, checkInRequestId,
                previousRequestId, null, outletId, emptyList(), null, null, null, null, null, at = 100,
                callSheet = CallSheetPayload.activity(sheet, drafts)), 100)
        }
    }
    private inner class Transport : VisitTransport {
        val sent = mutableListOf<ByteArray>()
        var loseActivityAck = false
        override fun challenge(deviceId: String) = java.util.UUID.randomUUID().toString() to 60_100L
        override fun token(refresh: Boolean) = "test-only"
        override fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
            assertEquals(RequestSigner.bodyDigest(bytes), headers["x-mobile-body-digest"])
            if (path.endsWith("pull")) return 200 to JSONObject().put("type", "pull.response")
                .put("contractVersion", 1).put("serverTime", 100).put("changes", JSONArray())
                .put("nextCursor", "next").put("hasMore", false).toString()
            sent += bytes.copyOf()
            val ops = JSONObject(String(bytes)).getJSONArray("operations")
            val first = ops.getJSONObject(0)
            if (first.getString("kind") == "visit.activity" && loseActivityAck) {
                loseActivityAck = false; return 503 to ""
            }
            val results = JSONArray()
            for (i in 0 until ops.length()) {
                val op = ops.getJSONObject(i)
                results.put(JSONObject().put("clientRequestId", op.getString("clientRequestId"))
                    .put("kind", op.getString("kind")).put("status", "accepted")
                    .put("ack", JSONObject().put("entityId", if (op.getString("kind") == "visit.checkIn")
                        "real-server-visit" else "real-server-activity").put("eventIds", JSONArray()).put("serverTime", 200)))
            }
            return 200 to JSONObject().put("type", "push.response").put("contractVersion", 1)
                .put("serverTime", 200).put("results", results).toString()
        }
    }
    @Test fun controllerQueueAckMaterializationAndUncertainReplayKeepStableBytes() = runBlocking {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val controller = FieldController(Backend(store), this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.start().join(); controller.openDiagnostic(visit).join()
        assertNotNull(controller.diagnosticCallSheet)
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        val check = store.history().single().first
        var cleared = 0
        controller.queueCallSheet(listOf(CallSheetDraftLine("product-1", order = "12"))) { cleared++ }.join()
        assertEquals(1, cleared); assertNull(controller.diagnosticError)
        val queued = store.history().last().first
        val template = queued.serializedOperation
        val operation = JSONObject(template)
        assertEquals("@checkin:${check.requestId}", operation.getJSONObject("payload").getString("visitId"))
        assertEquals(check.requestId, operation.getJSONArray("dependsOn").getString(0))
        assertEquals(listOf(100L, 101L), store.history().map { it.first.createdAt })
        val transport = Transport().apply { loseActivityAck = true }
        val sync = VisitSync(SignedVisitGateway(transport, signer, scope.deviceId, { 0 }), store, scope, {}, pause = {}, jitter = { 0 })
        sync.sync()
        assertEquals("real-server-visit", store.ack(check.requestId)!!.entityId)
        assertEquals("pending", store.history().last().second.state)
        sync.sync()
        assertEquals("done", store.history().last().second.state)
        assertNotNull(store.ack(queued.requestId))
        assertEquals(template, store.intent(queued.requestId)!!.serializedOperation)
        assertEquals(3, transport.sent.size)
        assertArrayEquals(transport.sent[1], transport.sent[2])
        val wire = JSONObject(String(transport.sent[1])).getJSONArray("operations").getJSONObject(0)
        assertEquals("real-server-visit", wire.getJSONObject("payload").getString("visitId"))
        assertEquals(queued.requestId, wire.getString("clientRequestId"))
        assertEquals(check.requestId, wire.getJSONArray("dependsOn").getString(0))
        assertEquals("call_sheet", wire.getJSONObject("payload").getJSONObject("activity").getString("kind"))
        assertFalse(String(transport.sent[1]).contains("@checkin:"))
        controller.openDiagnostic(visit).join()
        assertEquals("done", controller.diagnosticRows.last().second)
    }
    @Test fun openingTheCallSheetLoadsSuggestionsButQueuesNothingUntilSave() = runBlocking {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val backend = Backend(store)
        val controller = FieldController(backend, this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.start().join(); controller.openDiagnostic(visit).join()
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        controller.openCallSheet().join()
        assertEquals(listOf("outlet-1"), backend.suggestionCalls)
        val order = controller.suggestedOrder.order!!
        val sheet = controller.diagnosticCallSheet!!
        // Accepting fills a local draft only: still just the check-in in the outbox.
        val drafts = SuggestedOrderRules.useAll(order, sheet, sheet.lines.map { CallSheetDraftLine(it.productId) })
        assertEquals(listOf("8", ""), drafts.map { it.order })
        assertEquals(1, store.history().size)
        // The salesperson edits the accepted number before saving; the edit is what is saved.
        controller.queueCallSheet(drafts.map { if (it.productId == "product-1") it.copy(order = "6") else it }).join()
        assertEquals(2, store.history().size)
        val lines = JSONObject(store.history().last().first.serializedOperation).getJSONObject("payload")
            .getJSONObject("activity").getJSONArray("lines")
        assertEquals(1, lines.length()); assertEquals(6, lines.getJSONObject(0).getInt("order"))
        controller.signOut().join()
        assertNull(controller.suggestedOrder.order)
    }
    @Test fun twoPlannedVisitsAtOneOutletKeepSeparateCheckInAndCallSheetChains() = runBlocking {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val controller = FieldController(Backend(store), this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.openDiagnostic(visit).join()
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        controller.queueCallSheet(listOf(CallSheetDraftLine("product-1", order = "1"))).join()
        val firstCheckIn = store.history().first().first
        // Field-day rule: the open call must end before the next planned call starts.
        val secondVisit = visit.copy(plannedVisitId = "planned-2")
        controller.openDiagnostic(secondVisit).join()
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        assertEquals(VisitRuleFailure.Code.CALL_OPEN, controller.diagnosticFailure)
        controller.openDiagnostic(visit).join()
        controller.queueDiagnostic("visit.checkOut", null, null, "completed", null).join()
        controller.openDiagnostic(secondVisit).join()
        assertTrue(controller.relatedVisitRows(secondVisit).isEmpty())
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        assertNull(controller.diagnosticError)
        val secondCheckIn = store.history().last().first
        controller.queueCallSheet(listOf(CallSheetDraftLine("product-1", order = "2"))).join()
        val secondSheet = JSONObject(store.history().last().first.serializedOperation)
        assertEquals(secondCheckIn.requestId, secondSheet.getJSONArray("dependsOn").getString(0))
        assertEquals("@checkin:${secondCheckIn.requestId}", secondSheet.getJSONObject("payload").getString("visitId"))
        assertNotEquals(firstCheckIn.clientVisitId, secondCheckIn.clientVisitId)
        assertEquals(3, controller.relatedVisitRows(visit).size)
        assertEquals(2, controller.relatedVisitRows(secondVisit).size)
    }
    @Test fun missingCallSheetSetupDoesNotQueueActivity() = runBlocking {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot().copy(callSheets = emptyList())), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val controller = FieldController(Backend(store), this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.openDiagnostic(visit).join()
        assertNull(controller.diagnosticCallSheet)
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        controller.queueCallSheet(listOf(CallSheetDraftLine("product-1", order = "1"))).join()
        assertEquals(1, store.history().size); assertNotNull(controller.diagnosticError)
    }
    @Test fun repeatedSavesAreSeparateActivitiesOrderedBehindPriorRequest() = runBlocking {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val controller = FieldController(Backend(store), this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.openDiagnostic(visit).join(); controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        repeat(2) { controller.queueCallSheet(listOf(CallSheetDraftLine("product-2", take = "0"))).join() }
        val rows = store.history().map { it.first }
        assertEquals(3, rows.size); assertEquals(3, rows.map { it.requestId }.distinct().size)
        assertEquals(rows[1].requestId, JSONObject(rows[2].serializedOperation).getJSONArray("dependsOn").getString(0))
    }
    @Test fun emptyInvalidUncheckedAndClosedVisitDoNotQueueOrClearDrafts() = runBlocking {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val controller = FieldController(Backend(store), this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.openDiagnostic(visit).join()
        val drafts = listOf(CallSheetDraftLine("product-1", order = "1"))
        var cleared = 0
        controller.queueCallSheet(drafts) { cleared++ }.join()
        assertTrue(store.history().isEmpty()); assertNotNull(controller.diagnosticError)
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        for (value in listOf("", "-1", "1.5", "1000001")) {
            controller.queueCallSheet(listOf(CallSheetDraftLine("product-1", order = value))) { cleared++ }.join()
            assertEquals(1, store.history().size)
        }
        controller.queueDiagnostic("visit.checkOut", null, null, "completed", null).join()
        controller.queueCallSheet(drafts) { cleared++ }.join()
        assertEquals(2, store.history().size); assertEquals(0, cleared)
    }
    /**
     * Release counterexample: open store A (its success is held in flight), then B, then A again, whose newer
     * request is refused. When the first A success finally lands it must neither show nor renew the cache.
     */
    @Test fun anOldStoreAnswerCannotUndoANewerRefusalAfterAStoreSwitch() = runBlocking {
        SuggestedOrderRepository.forgetSessionDenials()
        val json = javaClass.classLoader!!.getResourceAsStream("for-outlet.json")!!.bufferedReader().use { it.readText() }
        val a = JSONObject(json).getJSONObject("outlet").getString("outletId")
        val day = JSONObject(json).getString("asOfDate")
        val rows = mutableMapOf<String, SuggestedOrderCacheRow>()
        val cache = object : SuggestedOrderCache {
            override fun read(key: String) = synchronized(rows) { rows[key] }
            override fun write(key: String, json: String, savedAt: Long) { synchronized(rows) { rows[key] = SuggestedOrderCacheRow(json, savedAt) } }
            override fun block(key: String, reason: String, at: Long) { synchronized(rows) { rows[key] = SuggestedOrderCacheRow(null, at, reason) } }
        }
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val calls = java.util.concurrent.atomic.AtomicInteger()
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val backend = object : FieldBackend by Backend(store) {
            override fun suggestedOrder(outletId: String): SuggestedOrderView =
                if (outletId != a) SuggestedOrderView(message = "store B")
                else SuggestedOrderRepository.load(a, day, cache, 1) {
                    if (calls.incrementAndGet() == 1) {
                        entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)); json
                    } else throw com.sunpride.field.auth.ConvexFunctionError("Forbidden")
                }
        }
        val controller = FieldController(backend, this, Dispatchers.IO, Dispatchers.Unconfined, now = { 100L })
        controller.start().join()
        val old = controller.loadSuggestedOrder(a)
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        controller.loadSuggestedOrder("store-b").join()
        controller.loadSuggestedOrder(a).join()
        assertNull(controller.suggestedOrder.order)
        assertEquals(SuggestedOrderRepository.NOT_ALLOWED, controller.suggestedOrder.message)
        release.countDown(); old.join()
        // Neither the screen nor the phone's cache takes the overtaken answer.
        assertNull(controller.suggestedOrder.order)
        assertEquals(SuggestedOrderRepository.NOT_ALLOWED, controller.suggestedOrder.message)
        assertNull(rows.getValue("$day|$a").json)
        val reopened = SuggestedOrderRepository.load(a, day, cache, 2) { throw com.sunpride.field.auth.AuthFailure(
            com.sunpride.field.auth.AuthFailure.Kind.OFFLINE) }
        assertNull(reopened.order); assertEquals(SuggestedOrderRepository.NOT_ALLOWED, reopened.message)
        SuggestedOrderRepository.forgetSessionDenials()
    }

    /** A backend whose authorization lifetime and enrollment the test controls; suggestions can be held in flight. */
    private inner class LifetimeBackend(store: FakeFieldStore) : FieldBackend by Backend(store) {
        @Volatile var epoch = 0L
        @Volatile var enrollment: EnrollmentState = EnrollmentState.Ready(scope.deviceId)
        @Volatile var hold: java.util.concurrent.CountDownLatch? = null
        val entered = java.util.concurrent.CountDownLatch(1)
        override val authorizationEpoch get() = epoch
        override fun refreshEnrollment(signer: DeviceSigner) = enrollment
        override fun suggestedOrder(outletId: String): SuggestedOrderView {
            hold?.let { entered.countDown(); check(it.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
            return SuggestedOrderView(SuggestedOrder("v1", "2026-09-29", outletId, 8, 7, 1, true, listOf(
                SuggestedLine("product-1", "SUNP-001", "Hotdog", "PC", "suggest", 8.0, listOf("Suggest 8 PC")))))
        }
    }
    private suspend fun lifetimeController(backend: LifetimeBackend, scope: kotlinx.coroutines.CoroutineScope) =
        FieldController(backend, scope, Dispatchers.IO, Dispatchers.Unconfined, now = { 100L }).also { it.start().join() }

    /** Verified scope A → B: suggestions already on screen are cleared at the next sync. */
    @Test fun publishedSuggestionsAreClearedWhenTheScopeChanges() = runBlocking {
        val store = FakeFieldStore(scope); store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val backend = LifetimeBackend(store)
        val controller = lifetimeController(backend, this)
        controller.loadSuggestedOrder("outlet-1").join()
        assertNotNull(controller.suggestedOrder.order)
        controller.syncNow().join() // same lifetime: kept
        assertNotNull(controller.suggestedOrder.order)
        backend.epoch++ // the sync verified a new scope
        controller.syncNow().join()
        assertNull(controller.suggestedOrder.order)
        // Removal confirmed while suggestions are on screen clears them too.
        controller.loadSuggestedOrder("outlet-1").join()
        assertNotNull(controller.suggestedOrder.order)
        backend.enrollment = EnrollmentState.Removed
        controller.checkAgain().join()
        assertNull(controller.suggestedOrder.order)
    }

    /** An answer asked under scope A never shows after A → B, nor after A → B → A. */
    @Test fun aLateAnswerFromAnEndedLifetimeIsNotShown() = runBlocking {
        for (changes in 1..2) {
            val store = FakeFieldStore(scope); store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
            val backend = LifetimeBackend(store)
            val controller = lifetimeController(backend, this)
            val release = java.util.concurrent.CountDownLatch(1)
            backend.hold = release
            val load = controller.loadSuggestedOrder("outlet-1")
            assertTrue(backend.entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            repeat(changes) { backend.epoch++ }
            release.countDown(); load.join()
            assertNull(controller.suggestedOrder.order)
            assertFalse(controller.suggestedOrder.loading)
            // A fresh request in the current lifetime works.
            backend.hold = null
            controller.loadSuggestedOrder("outlet-1").join()
            assertNotNull(controller.suggestedOrder.order)
        }
    }

    /** Confirmed phone removal retires both the shown suggestions and an answer still in flight. */
    @Test fun phoneRemovalRetiresShownAndInFlightSuggestions() = runBlocking {
        val store = FakeFieldStore(scope); store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val backend = LifetimeBackend(store)
        val controller = lifetimeController(backend, this)
        controller.loadSuggestedOrder("outlet-1").join()
        assertNotNull(controller.suggestedOrder.order)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.hold = release
        val load = controller.loadSuggestedOrder("outlet-1")
        assertTrue(backend.entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        backend.enrollment = EnrollmentState.Removed
        controller.checkAgain().join()
        assertEquals(EnrollmentState.Removed, controller.state)
        assertNull(controller.suggestedOrder.order)
        release.countDown(); load.join()
        assertNull(controller.suggestedOrder.order)
    }
}
