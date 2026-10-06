package com.sunpride.field.orders

import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.sync.SignedVisitGateway
import com.sunpride.field.sync.VisitSync
import com.sunpride.field.sync.VisitTransport
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.saveOrderDraftIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import kotlin.coroutines.EmptyCoroutineContext

/** SP-0060 (AND-015): review totals and local rules, then one idempotent queued submission with status. */
class OrderSubmissionTest {
    private val scope = StoreScope("issuer|person", "device", "scope")
    private val visit = VisitDisplay("Account", "Planned", "Scheduled", "outlet-1", "planned-1", customerCode = "CUST-1")
    private val outletJson = JSONObject().put("id", "outlet-1").put("name", "Outlet One").put("routeId", "route-1")
        .put("customerId", "customer-1").put("territoryId", "territory-1").put("territoryCode", "PASIG-01")

    private fun snapshot(): ScopedSnapshot {
        val text = javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!
            .bufferedReader().use { it.readText() }
        return BootstrapCodec.snapshot(listOf(BootstrapCodec.page(text))).copy(
            outlets = listOf(SnapshotItem("outlet-1", outletJson.toString())),
            localCustomers = listOf(SnapshotItem("customer-1", JSONObject().put("id", "customer-1").put("code", "CUST-1").toString())))
    }
    private suspend fun ready(lease: Long = Long.MAX_VALUE) = FakeFieldStore(scope).apply {
        swap(stage(snapshot()), "cursor", lease, Long.MAX_VALUE)
    }
    private suspend fun checkIn(store: FakeFieldStore): IntentRow =
        VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, "planned-1", "outlet-1", emptyList(),
            null, null, null, null, null, at = 100).also { store.enqueue(it, 100) }
    private fun failure(block: suspend () -> Unit): OrderDraftFailure.Code =
        (runCatching { runBlocking { block() } }.exceptionOrNull() as? OrderDraftFailure
            ?: error("Expected an order failure")).code
    private suspend fun rows(store: FakeFieldStore) = store.history().map { it.first to it.second.state }

    @Test fun legacyTotalsSumUnitsAndLeaveAllLinesForTheOffice() = runBlocking {
        val store = ready(); val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId,
            listOf("product-1" to 1200, "product-2" to 12), 500)
        val totals = OrderSubmission.totals(draft)
        assertEquals(OrderTotals(2, listOf("PC" to 1200, "CAN" to 12), 0L, 2), totals)
        assertEquals("2 products · 1,200 PC · 12 CAN", totals.text)
        assertEquals("1 product · 3 PC", OrderSubmission.totals(draft.copy(lines = listOf(draft.lines.first().copy(quantity = 3)))).text)
        val activity = OrderSubmission.activity(draft)
        assertEquals(setOf("kind", "clientOrderId", "lines"), activity.keys().asSequence().toSet())
        assertEquals("order_intent", activity.getString("kind")); assertEquals(draft.draftId, activity.getString("clientOrderId"))
        val line = activity.getJSONArray("lines").getJSONObject(0)
        assertEquals(setOf("productId", "uom", "quantity"), line.keys().asSequence().toSet())
        assertFalse(activity.toString().contains("price") || activity.toString().contains("amount"))
        OrderSubmission.validateActivity(activity)
        val bad = listOf(
            JSONObject(activity.toString()).put("note", "x"),
            JSONObject(activity.toString()).put("clientOrderId", "not-a-uuid"),
            JSONObject(activity.toString()).put("lines", JSONArray()),
            JSONObject(activity.toString()).put("lines", JSONArray().put(JSONObject(line.toString()).put("quantity", 0))),
            JSONObject(activity.toString()).put("lines", JSONArray().put(JSONObject(line.toString()).put("quantity", 100_000))),
            JSONObject(activity.toString()).put("lines", JSONArray().put(JSONObject(line.toString()).put("uom", ""))),
            JSONObject(activity.toString()).put("lines", JSONArray().put(JSONObject(line.toString()).put("unitPrice", 189))),
            JSONObject(activity.toString()).put("lines", JSONArray().put(line).put(line)))
        bad.forEach { assertThrows(it.toString(), Exception::class.java) { OrderSubmission.validateActivity(it) } }
    }

    @Test fun submitQueuesOneOrderActivityAndFreezesTheDraft() = runBlocking {
        val store = ready(); val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-2" to 12), 500)
        assertEquals(OrderStatus.DRAFT, OrderSubmission.status(draft, rows(store)))
        assertTrue(OrderSubmission.checks(store, draft, 600).all { it.ok })

        val sent = submitOrderDraftIn(store, scope, draft.draftId, check.requestId, 600)
        val queued = store.history().last().first
        assertEquals(sent.submittedRequestId, queued.requestId); assertEquals(600L, sent.submittedAt)
        assertEquals("visit.activity", queued.kind); assertEquals(check.clientVisitId, queued.clientVisitId)
        val op = JSONObject(queued.serializedOperation)
        assertEquals(check.requestId, op.getJSONArray("dependsOn").getString(0))
        // Local template reference, replaced by the server visit ID only after the check-in ack.
        assertEquals("@checkin:${check.requestId}", op.getJSONObject("payload").getString("visitId"))
        assertTrue(OrderSubmission.sameActivity(OrderSubmission.activity(draft), op.getJSONObject("payload").getJSONObject("activity")))
        assertEquals(OrderStatus.QUEUED, OrderSubmission.status(sent, rows(store)))
        assertEquals("order_intent" in ActivityRules.recordedKinds(check.clientVisitId, rows(store)), true)

        // Idempotent: the same order is never queued twice, edited or discarded after sending.
        assertEquals(OrderDraftFailure.Code.SUBMITTED, failure { submitOrderDraftIn(store, scope, draft.draftId, queued.requestId, 700) })
        assertEquals(OrderDraftFailure.Code.SUBMITTED, failure {
            saveOrderDraftIn(store, draft.draftId, check.clientVisitId, check.requestId, listOf("product-2" to 1), 700)
        })
        assertEquals(OrderDraftFailure.Code.SUBMITTED, failure { store.discardOrderDraft(draft.draftId) })
        assertEquals(2, store.history().size)
        assertEquals(OrderDraftFailure.Code.SUBMITTED.text,
            OrderSubmission.checks(store, store.orderDrafts().single(), 700).single { !it.ok }.problem)
        // The codec round-trips the marker and still reads SP-0061 rows that predate it.
        val stored = store.orderDrafts().single()
        assertEquals(stored, OrderDraftCodec.decode(OrderDraftCodec.encode(stored)))
        val legacy = JSONObject(OrderDraftCodec.encode(draft)).apply { remove("submittedRequestId"); remove("submittedAt") }
        assertEquals(draft, OrderDraftCodec.decode(legacy.toString()))
    }

    @Test fun forgedOrUnmatchedOrderRequestsNeverReachTheOutbox() = runBlocking {
        val store = ready(); val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-2" to 12), 500)
        val changed = OrderSubmission.intent(scope, draft.copy(lines = listOf(draft.lines.single().copy(quantity = 13))),
            check.requestId, 600)
        assertTrue(runCatching { store.submitOrderDraft(draft.draftId, changed, 600) }.isFailure)
        val unknown = OrderSubmission.intent(scope, draft.copy(draftId = UUID.randomUUID().toString()), check.requestId, 600)
        assertTrue(runCatching { store.enqueue(unknown, 600) }.isFailure)
        assertEquals(1, store.history().size)
        assertNull(store.orderDrafts().single().submittedRequestId)
    }

    /** Submitting order B under draft A must not freeze A while B goes out. */
    @Test fun aDraftIsFrozenOnlyByItsOwnOrderRequest() = runBlocking {
        val store = ready(); val check = checkIn(store)
        val a = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-2" to 12), 500)
        val b = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-2" to 3), 510)
        val intentB = OrderSubmission.intent(scope, b, check.requestId, 600)
        assertTrue(runCatching { store.submitOrderDraft(a.draftId, intentB, 600) }.exceptionOrNull()
            is IllegalArgumentException)
        assertEquals(1, store.history().size)
        assertTrue(store.orderDrafts().all { it.submittedRequestId == null })
        store.submitOrderDraft(b.draftId, intentB, 600)
        assertEquals(intentB.requestId, store.orderDrafts().single { it.draftId == b.draftId }.submittedRequestId)
        assertNull(store.orderDrafts().single { it.draftId == a.draftId }.submittedRequestId)
    }

    @Test fun reviewChecksReportEndedCallChangedSetupAndExpiredAccess() = runBlocking {
        val store = ready(lease = 1_000); val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 2), 500)
        val expired = OrderSubmission.checks(store, draft, 2_000)
        assertEquals(listOf(OrderDraftFailure.Code.OFFLINE_EXPIRED.text), expired.mapNotNull { it.problem })
        assertEquals(OrderDraftFailure.Code.OFFLINE_EXPIRED, failure { submitOrderDraftIn(store, scope, draft.draftId, check.requestId, 2_000) })
        val stale = OrderSubmission.checks(store, draft.copy(catalogRevision = 1), 600)
        assertTrue(stale.any { it.problem == OrderDraftFailure.Code.CATALOG_CHANGED.text })
        store.enqueue(VisitIntentFactory.create(scope, "visit.checkOut", check.clientVisitId, check.requestId,
            check.requestId, null, "outlet-1", emptyList(), null, null, "completed", null, null, at = 700), 700)
        assertEquals(OrderDraftFailure.Code.CALL_ENDED.text, OrderSubmission.checks(store, draft, 800).first().problem)
        assertEquals(OrderDraftFailure.Code.CALL_ENDED, failure {
            submitOrderDraftIn(store, scope, draft.draftId, store.history().last().first.requestId, 800)
        })
        assertEquals(OrderStatus.NOT_SENT, OrderSubmission.status(draft, rows(store)))
        assertNull(store.orderDrafts().single().submittedRequestId)
    }

    @Test fun heldPartitionRefusesSubmission() = runBlocking {
        val store = ready(); val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 2), 500)
        store.holdForReview()
        assertEquals(OrderDraftFailure.Code.HELD, failure { submitOrderDraftIn(store, scope, draft.draftId, check.requestId, 600) })
        assertEquals(1, store.history().size)
    }

    private class Signer : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private class Transport(val accept: (JSONObject) -> String) : VisitTransport {
        val pushed = mutableListOf<JSONObject>()
        override fun challenge(deviceId: String) = UUID.randomUUID().toString() to 1_790_380_860_000L
        override fun token(refresh: Boolean) = "bearer"
        override fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
            val body = JSONObject(String(bytes))
            if (path.endsWith("pull")) return 200 to JSONObject().put("type", "pull.response").put("contractVersion", 1)
                .put("serverTime", 1).put("changes", JSONArray()).put("nextCursor", "next").put("hasMore", false).toString()
            val results = JSONArray()
            val ops = body.getJSONArray("operations")
            for (i in 0 until ops.length()) {
                val op = ops.getJSONObject(i); pushed += op
                val status = accept(op)
                results.put(JSONObject().put("kind", op.getString("kind")).put("clientRequestId", op.getString("clientRequestId"))
                    .put("status", status).apply {
                        if (status == "accepted") put("ack", JSONObject().put("entityId",
                            if (op.getString("kind") == "visit.checkIn") "server-visit" else "server-activity")
                            .put("eventIds", JSONArray().put("event-1")).put("serverTime", 1))
                        else put("code", "invalid_request")
                    })
            }
            return 200 to JSONObject().put("type", "push.response").put("contractVersion", 1).put("serverTime", 1)
                .put("results", results).toString()
        }
    }

    @Test fun syncSendsTheOrderWithTheServerVisitAndShowsReceivedOrNeedsReview() = runBlocking {
        for ((verdict, expected) in listOf("accepted" to OrderStatus.RECEIVED, "rejected" to OrderStatus.NEEDS_REVIEW)) {
            val store = ready(); val check = checkIn(store)
            val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-2" to 12), 500)
            submitOrderDraftIn(store, scope, draft.draftId, check.requestId, 600)
            val transport = Transport { op -> if (op.getJSONObject("payload").has("activity")) verdict else "accepted" }
            VisitSync(SignedVisitGateway(transport, Signer(), scope.deviceId) { 0L }, store, scope, {},
                now = { 600 }, pause = {}, jitter = { 0 }).sync()
            val order = transport.pushed.single { it.getString("kind") == "visit.activity" }
            assertEquals("server-visit", order.getJSONObject("payload").getString("visitId"))
            assertEquals(12, order.getJSONObject("payload").getJSONObject("activity").getJSONArray("lines")
                .getJSONObject(0).getInt("quantity"))
            assertEquals(expected, OrderSubmission.status(store.orderDrafts().single(), rows(store)))
        }
    }

    private val signer = Signer()
    private inner class Backend(val store: FakeFieldStore) : FieldBackend {
        override val isSignedIn = true
        override val cachedDeviceId = scope.deviceId
        override fun loadSigner() = signer
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(scope.deviceId)
        override fun visitStates() = runBlocking { store.history().map { it.first to it.second.state } }
        override fun callSheet(outletId: String) = runBlocking { store.callSheet(outletId) }
        override fun orderDrafts() = runBlocking { store.orderDrafts() }
        override fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
            quantities: List<Pair<String, Int>>) = runBlocking {
            saveOrderDraftIn(store, draftId, clientVisitId, checkInRequestId, quantities, 100)
        }
        override fun orderChecks(draftId: String) = runBlocking {
            OrderSubmission.checks(store, store.orderDrafts().single { it.draftId == draftId }, 100)
        }
        override fun submitOrderDraft(draftId: String, previousRequestId: String) = runBlocking {
            submitOrderDraftIn(store, scope, draftId, previousRequestId, 100)
        }
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: JSONObject?) = runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, kind, clientVisitId, checkInRequestId, previousRequestId,
                plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode, location, at = 100), 100)
        }
    }

    @Test fun controllerReviewsSubmitsAndShowsTheSentOrderReadOnly() = runBlocking {
        val store = ready()
        val controller = FieldController(Backend(store), this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.openDiagnostic(visit).join()
        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        controller.openOrder().join()
        controller.openOrderReview().join()
        assertFalse(controller.orderReview) // nothing saved yet: no review
        controller.saveOrderDraft(listOf("product-1" to 2, "product-2" to 6)).join()
        controller.openOrderReview().join()
        assertTrue(controller.orderReview)
        assertTrue(controller.orderChecks.isNotEmpty() && controller.orderChecks.all { it.ok })
        controller.closeOrderReview().join() // Edit goes back to the editor
        assertTrue(controller.orderOpen); assertFalse(controller.orderReview)
        controller.openOrderReview().join()
        controller.submitOrder().join()
        assertNull(controller.diagnosticError)
        val sent = controller.visitOrderDrafts.single()
        assertNotNull(sent.submittedRequestId)
        assertEquals(OrderStatus.QUEUED, controller.orderStatus(sent))
        assertEquals(listOf("visit.checkIn", "visit.activity"), store.history().map { it.first.kind })
        assertTrue(controller.orderChecks.any { it.problem == OrderDraftFailure.Code.SUBMITTED.text })
        // A second tap never queues it again.
        controller.submitOrder().join()
        assertEquals(OrderDraftFailure.Code.SUBMITTED.text, controller.diagnosticError)
        assertEquals(2, store.history().size)
        // Back from a sent order's review closes it (no editor); reopening goes straight to the read-only review.
        controller.closeOrderReview().join()
        assertFalse(controller.orderOpen)
        controller.openOrder(sent.draftId).join()
        assertTrue(controller.orderReview)
        // An order rule that requires order_intent is now satisfied by the queued order.
        assertTrue("order_intent" in ActivityRules.recordedKinds(sent.clientVisitId, controller.diagnosticRows))
    }
}
