package com.sunpride.field.ui

import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.ui.diagnosticvisit.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

/** AND-013: multi-intent visits and backend-rule activity forms through the controller and store. */
class ActivityControllerTest {
    private val scope = StoreScope("issuer|person", "device", "scope")
    private val planned = VisitDisplay("Account", "Planned", "Scheduled", "outlet-1", "planned-1",
        intents = listOf("merchandise"))
    private val unplanned = VisitDisplay("Account", "Unplanned", "Reason required", "outlet-1")
    private val signer = object : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private fun fixture(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }
    /** Call-sheet fixture plus the rules fixture's rule set (one coherent download). */
    private fun snapshot(): ScopedSnapshot {
        val rules = BootstrapCodec.page(fixture("bootstrap-activity-rules-response.json")).activityRules!!
        return BootstrapCodec.snapshot(listOf(BootstrapCodec.page(fixture("bootstrap-call-sheet-response.json"))))
            .copy(activityRules = rules)
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
        override fun activityRules() = runBlocking { store.activityRules() }
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: JSONObject?) = runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, kind, clientVisitId, checkInRequestId, previousRequestId,
                plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode, location, at = 100), 100)
        }
        override fun queueActivity(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
            outletId: String, activity: JSONObject) = runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, "visit.activity", clientVisitId, checkInRequestId,
                previousRequestId, null, outletId, emptyList(), null, null, null, null, null, at = 100,
                activity = activity), 100)
        }
    }
    private suspend fun kotlinx.coroutines.CoroutineScope.controller(): Pair<FieldController, FakeFieldStore> {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot()), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        return FieldController(Backend(store), this, Dispatchers.Unconfined,
            EmptyCoroutineContext, now = { 100L }) to store
    }

    @Test fun plannedVisitRequiresItsRuleFormsBeforeACompletedEnd() = runBlocking {
        val (c, store) = controller()
        c.openDiagnostic(planned).join()
        assertEquals(listOf("merchandise"), c.visitIntents(planned))
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        assertEquals(listOf("merchandise"), JSONObject(store.history().single().first.serializedOperation)
            .getJSONObject("payload").getJSONArray("intents").let { a -> (0 until a.length()).map { a.getString(it) } })
        assertEquals(listOf("merchandising" to true, "price_check" to false),
            c.activityChecklist(planned).map { it.kind to it.required })
        c.queueDiagnostic("visit.checkOut", null, null, "completed", null).join()
        assertEquals(VisitRuleFailure.Code.ACTIVITIES_REQUIRED, c.diagnosticFailure)
        assertEquals(1, store.history().size)
        // The store refuses it too, even if a caller skips the controller.
        val start = store.history().single().first
        assertThrows(VisitRuleFailure::class.java) { runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, "visit.checkOut", start.clientVisitId, start.requestId,
                start.requestId, null, "outlet-1", emptyList(), null, null, "completed", null, null, at = 100), 100)
        } }
        c.openActivityForm("merchandising").join()
        assertEquals("merchandising", c.activityForm)
        c.queueActivity(ActivityForms.merchandising("needs_action", "Re-faced shelf")).join()
        assertNull(c.diagnosticError); assertNull(c.activityForm)
        val queued = JSONObject(store.history().last().first.serializedOperation)
        assertEquals("@checkin:${start.requestId}", queued.getJSONObject("payload").getString("visitId"))
        assertEquals("merchandising", queued.getJSONObject("payload").getJSONObject("activity").getString("kind"))
        assertEquals(ActivityRequirement.Status.DONE, c.activityChecklist(planned).first().status)
        c.queueDiagnostic("visit.checkOut", null, null, "completed", null).join()
        assertNull(c.diagnosticFailure)
        assertEquals(listOf("visit.checkIn", "visit.activity", "visit.checkOut"), store.history().map { it.first.kind })
    }

    @Test fun endIsReviewedThenQueuedOnceAndTheVisitBecomesFinal() = runBlocking {
        val (c, store) = controller()
        c.openDiagnostic(planned).join()
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        c.reviewEnd("completed", null).join()
        assertEquals(VisitRuleFailure.Code.ACTIVITIES_REQUIRED, c.diagnosticFailure)
        assertNull(c.endReview)
        c.openActivityForm("merchandising").join()
        c.queueActivity(ActivityForms.merchandising("compliant", "")).join()
        c.reviewEnd("completed", null).join()
        assertEquals(listOf("merchandising"), c.endReview!!.recorded)
        assertEquals(1, store.history().count { it.first.kind == "visit.activity" }) // review queues nothing
        c.cancelEnd().join(); assertNull(c.endReview)
        c.reviewEnd("completed", null).join()
        val location = JSONObject().put("latitude", 14.5).put("longitude", 121.0).put("accuracyMeters", 8)
            .put("fixTime", 100).put("provider", "fused").put("mockSignal", false)
        c.queueDiagnostic("visit.checkOut", null, null, "completed", location).join()
        assertNull(c.diagnosticFailure); assertNull(c.endReview)
        val result = c.visitResult(planned)!!
        assertEquals("completed", result.outcome)
        assertEquals(listOf("merchandising"), result.recorded)
        assertEquals("End location recorded · ±8 m", result.location)
        assertEquals("Waiting to send", result.sync)
        // Final: no second End, no new activity, through the controller or straight into the store.
        c.reviewEnd("completed", null).join()
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, c.diagnosticFailure)
        c.queueDiagnostic("visit.activity", null, "late note", null, null).join()
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, c.diagnosticFailure)
        val start = store.history().first().first
        assertThrows(VisitRuleFailure::class.java) { runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, "visit.activity", start.clientVisitId, start.requestId,
                store.history().last().first.requestId, null, "outlet-1", emptyList(), null, "late", null, null, null,
                at = 100), 100)
        } }
        assertEquals(listOf("visit.checkIn", "visit.activity", "visit.checkOut"), store.history().map { it.first.kind })
        Unit
    }

    @Test fun notProductiveEndSkipsForms() = runBlocking {
        val (c, store) = controller()
        c.openDiagnostic(planned).join()
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        c.queueDiagnostic("visit.checkOut", "store_closed", null, "nonproductive", null).join()
        assertNull(c.diagnosticFailure)
        assertEquals(2, store.history().size)
    }

    @Test fun unplannedVisitNeedsChosenPurposesAndCarriesThemAll() = runBlocking {
        val (c, store) = controller()
        c.openDiagnostic(unplanned).join()
        c.queueDiagnostic("visit.checkIn", "Buyer called", null, null, null).join()
        assertEquals(VisitRuleFailure.Code.INTENT_REQUIRED, c.diagnosticFailure)
        assertTrue(store.history().isEmpty())
        c.toggleIntent("complaint").join(); c.toggleIntent("merchandise").join()
        c.toggleIntent("not-an-intent").join()
        assertEquals(listOf("merchandise", "complaint"), c.selectedIntents) // canonical order
        c.queueDiagnostic("visit.checkIn", "Buyer called", null, null, null).join()
        assertNull(c.diagnosticFailure)
        val payload = JSONObject(store.history().single().first.serializedOperation).getJSONObject("payload")
        assertEquals("""["merchandise","complaint"]""", payload.getJSONArray("intents").toString())
        // The rules fixture requires a note for complaints and merchandising for merchandise.
        assertEquals(listOf("merchandising", "price_check", "note"), c.activityChecklist(unplanned).map { it.kind })
        c.queueDiagnostic("visit.activity", null, "Damaged cans reported", null, null).join()
        c.queueActivity(ActivityForms.merchandising("compliant", "")).join()
        c.queueDiagnostic("visit.checkOut", null, null, "completed", null).join()
        assertNull(c.diagnosticFailure)
        assertEquals(4, store.history().size)
    }

    @Test fun invalidOrClosedFormIsNotQueued() = runBlocking {
        val (c, store) = controller()
        c.openDiagnostic(planned).join()
        c.queueActivity(ActivityForms.promotion("P", "executed")).join()
        assertEquals(VisitRuleFailure.Code.CALL_NOT_OPEN, c.diagnosticFailure)
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        c.queueActivity(JSONObject().put("kind", "price_check").put("productId", "unknown")
            .put("observedPriceMinor", 1).put("currency", "PHP")).join()
        assertNotNull(c.diagnosticError)
        assertEquals(1, store.history().size)
        c.queueActivity(ActivityForms.priceCheck(c.diagnosticCallSheet, "product-1", "45.25", true)).join()
        assertEquals(2, store.history().size)
        c.queueDiagnostic("visit.checkOut", "closed", null, "nonproductive", null).join()
        c.queueActivity(ActivityForms.promotion("P", "executed")).join()
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, c.diagnosticFailure)
        assertEquals(3, store.history().size)
    }
}
