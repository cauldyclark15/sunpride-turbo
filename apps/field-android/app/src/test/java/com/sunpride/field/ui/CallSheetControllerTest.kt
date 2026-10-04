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
}
